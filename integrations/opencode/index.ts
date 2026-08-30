import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AgentDeckClient,
  clip,
  clipMultiline,
  type AgentEventInput,
  type AgentState,
  type EventKind,
  type RemoteCommand,
} from "../../packages/agent-adapter/src/client";
import {
  describeToolCall,
  requiresApproval,
} from "../../packages/agent-adapter/src/approval-policy";
import type { ApprovalMode } from "../../packages/agent-adapter/src/approval-policy";
import type { RuntimeEventType } from "../../packages/agent-adapter/src/runtime-events";
import { mutatesFile, readFileForDiff } from "../../packages/agent-adapter/src/file-snapshot";
import { unifiedDiff } from "../../packages/agent-adapter/src/unified-diff";
import { asObject, asString, isJsonObject, type JsonObject, type JsonValue } from "./payload";
import { agentIdFor } from "../../packages/agent-adapter/src/agent-identity";
import { stateFromStatus, SubagentSessions } from "./session";
import { coarseDiff, fileTarget, shellCommand } from "./toolcall";

/**
 * Agent Deck as an OpenCode plugin.
 *
 * In-process rather than a hook per event, because OpenCode allows it. That is
 * the same reason the Pi extension is in-process and the Claude Code adapter is
 * not: where a runtime offers a plugin, there is no process to spawn and no
 * 200 ms to pay on every tool call.
 *
 * Being in-process also makes approvals answerable. `permission.ask` can hold
 * the call and write back a decision, so a phone can allow or deny an OpenCode
 * tool exactly as it already can for Pi. The same in-process channel is what
 * lets a phone steer the session: `client.session.prompt` injects a message
 * into a live turn, and `client.session.abort` stops one.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const COMMAND_INTERVAL_MS = 2_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** How often a streaming part republishes; tighter than this just re-sends bytes. */
const STREAMING_PUBLISH_INTERVAL_MS = 250;

function approvalModeFromEnv(mode: string | undefined): ApprovalMode {
  return mode === "off" || mode === "destructive" || mode === "all" ? mode : "destructive";
}

const approvalMode: ApprovalMode = approvalModeFromEnv(process.env.AGENT_DECK_APPROVAL_MODE);

const text = (value: JsonValue | undefined): string | undefined => {
  const candidate = asString(value);
  return candidate?.trim() ? candidate : undefined;
};

/** The slice of OpenCode's client this plugin needs to steer a session. */
type OpencodeSessionApi = {
  prompt: (input: {
    path: { id: string };
    body: { parts: Array<{ type: "text"; text: string }> };
  }) => Promise<void>;
  abort: (input: { path: { id: string } }) => Promise<void>;
};

export const AgentDeckPlugin = async (input: {
  client?: { session?: OpencodeSessionApi };
  project?: { id?: string };
  directory?: string;
  worktree?: string;
}) => {
  const client = new AgentDeckClient();
  const opencode = input.client?.session;
  const subagents = new SubagentSessions();
  // `worktree` is "/" for a directory OpenCode has no project for, and
  // basename("/") is the empty string - which reaches the deck as a session
  // with no name at all. The working directory is the honest fallback.
  const worktree = input.worktree && input.worktree !== "/" ? input.worktree : undefined;
  const workingDirectory = input.directory ?? process.cwd();
  const projectName = basename(worktree ?? workingDirectory) || "opencode";

  /**
   * The session this plugin instance is speaking for.
   *
   * OpenCode loads the plugin before any session exists, so this is filled in
   * by the first event that names one rather than taken from the input.
   */
  let sessionId: string | undefined;
  let state: AgentState = "idle";
  let task = "Ready for a remote instruction";
  let objective: string | undefined;
  let model = "OpenCode";
  let tokens = 0;
  let processedTokens = 0;
  let costUsd = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let commandTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let activeTurnId: string | undefined;
  let pendingApproval:
    | {
        id: string;
        toolName: string;
        detail: string;
        createdAt: string;
        expiresAt: string;
        decide: (approved: boolean) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /**
   * Facts captured when a tool call starts, consumed when it completes. The
   * hook adapter snapshots to disk because every hook is its own process; this
   * plugin lives for the whole session, so the before-image waits in memory.
   */
  const liveCalls = new Map<
    string,
    { command?: string; path?: string; before?: string | null; coarse?: string }
  >();
  /** Streaming publish state, per session so subagent text never splices into the parent's. */
  const streams = new Map<
    string,
    { textId?: string; reasoningId?: string; lastTextAt: number; lastReasoningAt: number }
  >();
  /** Ids of user messages, so their parts are not re-published as assistant output. */
  const userMessageIds = new Set<string>();
  /** Assistant messages whose usage is already counted; updates repeat, spend does not. */
  const accountedMessageIds = new Set<string>();

  const agentId = () => (sessionId ? agentIdFor("opencode", sessionId) : undefined);

  const heartbeat = async () => {
    const id = agentId();
    if (!id) return;
    await client
      .heartbeat({
        id,
        name: `OpenCode · ${projectName} · ${sessionId!.slice(-4)}`,
        project: projectName,
        cwd: workingDirectory,
        model,
        runtime: "opencode",
        runtimeProtocol: "canonical-v1",
        state,
        task,
        objective,
        tokens,
        processedTokens,
        costUsd,
        capabilities: ["approve", "reject", "steer", "prompt", "follow_up", "pause", "stop"],
        pendingApproval: pendingApproval
          ? {
              id: pendingApproval.id,
              tool: pendingApproval.toolName,
              detail: pendingApproval.detail,
              createdAt: pendingApproval.createdAt,
              expiresAt: pendingApproval.expiresAt,
            }
          : undefined,
      })
      .catch(() => {});
  };

  const publisher = client.publisher("opencode-plugin");
  const publishRuntime = async (
    type: RuntimeEventType,
    payload: Record<string, string | number | boolean | string[] | undefined>,
    refs: { id?: string; turnId?: string; itemId?: string; requestId?: string } = {},
  ) => {
    const id = agentId();
    if (!id) return;
    await publisher(id, type, payload, refs).catch(() => {});
  };

  /**
   * Moves the session and says so on the canonical stream.
   *
   * This adapter declares canonical-v1, so the deck believes the projection
   * and discards the heartbeat's state — a transition that only rode the
   * heartbeat never arrived: a remote pause or stop was invisible, and a
   * failed remote command could not show as an error. Most transitions
   * already travel as lifecycle events (turns, items, requests); this is for
   * the ones that have no event of their own.
   */
  const reportState = async (nextState: AgentState, nextTask?: string) => {
    const moved = nextState !== state || (nextTask !== undefined && nextTask !== task);
    state = nextState;
    if (nextTask !== undefined) task = nextTask;
    if (moved) await publishRuntime("session.state.changed", { state, task });
  };

  const publish = async (
    kind: EventKind,
    summary: string,
    detail?: string,
    extra: Omit<AgentEventInput, "kind" | "summary" | "detail"> = {},
  ) => {
    const id = agentId();
    if (!id) return;
    await client
      .event(id, {
        kind,
        summary: clip(summary, 120),
        detail: detail ? clipMultiline(detail) : undefined,
        // The turn is the deck's thread unit; every event rides under the
        // exchange that caused it unless the caller says otherwise.
        turnId: activeTurnId,
        ...extra,
      })
      .catch(() => {});
  };

  /** Starts the heartbeat and command loops once there is a session worth reporting. */
  const adopt = (nextSessionId: string) => {
    if (sessionId !== nextSessionId) {
      sessionId = nextSessionId;
      // Identity as an event, not only as a heartbeat field - see ADR-0001.
      void publishRuntime("session.registered", {
        name: `OpenCode · ${projectName} · ${nextSessionId.slice(-4)}`,
        project: projectName,
        model,
        runtime: "opencode",
        capabilities: ["approve", "reject", "steer", "prompt", "follow_up", "pause", "stop"],
      });
      void heartbeat();
    }
    if (!timer) timer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
    if (!commandTimer) commandTimer = setInterval(() => void pollCommands(), COMMAND_INTERVAL_MS);
  };

  /**
   * Where an event belongs: the top-level session it is reported on, and the
   * subagent tags it carries when it came from a child. OpenCode announces a
   * child's `parentID` on the session event that creates it, which is what
   * makes threading possible at all - the deck files the child's work under
   * the parent instead of dropping it.
   */
  const routeFor = (session: string | undefined) => {
    if (!session) return undefined;
    const root = subagents.rootOf(session);
    adopt(root);
    if (root === session) return { fromChild: false as const, tags: {} };
    const tags: Pick<AgentEventInput, "subagentId" | "subagentName"> = { subagentId: session };
    const name = subagents.nameOf(session);
    if (name) tags.subagentName = name;
    return { fromChild: true as const, tags };
  };

  /** The file a call is aimed at, anchored to the project when spelled relative. */
  const absoluteTarget = (args: JsonObject | undefined) => {
    const target = fileTarget(args);
    return target === undefined || target.startsWith("/") ? target : join(workingDirectory, target);
  };

  const streamOf = (session: string) => {
    let stream = streams.get(session);
    if (!stream) {
      stream = { lastTextAt: 0, lastReasoningAt: 0 };
      streams.set(session, stream);
    }
    return stream;
  };

  const settleApproval = (approved: boolean) => {
    const pending = pendingApproval;
    if (!pending) return false;
    pendingApproval = undefined;
    clearTimeout(pending.timeout);
    pending.decide(approved);
    return true;
  };

  /** One command from a device, executed against the live session. */
  const executeCommand = async (command: RemoteCommand) => {
    const id = agentId();
    if (!id) return;
    try {
      switch (command.action) {
        case "prompt":
        case "steer":
        case "follow_up": {
          if (!command.value?.trim()) throw new Error("Remote prompt was empty");
          objective = clip(command.value, 500);
          await reportState("running", clip(command.value));
          await opencode?.prompt({
            path: { id: sessionId! },
            body: { parts: [{ type: "text", text: command.value }] },
          });
          break;
        }
        case "pause":
          settleApproval(false);
          await opencode?.abort({ path: { id: sessionId! } });
          await reportState("paused", "Paused remotely");
          break;
        case "stop":
          settleApproval(false);
          await opencode?.abort({ path: { id: sessionId! } });
          await reportState("idle", "Stopped remotely");
          break;
        case "approve":
          settleApproval(true);
          break;
        case "reject":
          settleApproval(false);
          break;
      }
      void publish("output", `Remote command: ${command.action}`, command.value);
    } catch (error) {
      await reportState("error");
      void publish(
        "error",
        `Remote command failed: ${command.action}`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await client.acknowledge(id, command.id).catch(() => {});
      void heartbeat();
    }
  };

  const pollCommands = async () => {
    const id = agentId();
    if (!id || polling) return;
    polling = true;
    try {
      const commands = await client.commands(id);
      for (const command of commands) await executeCommand(command);
    } catch {
      // Heartbeats own the visible connection status; command polling is best-effort.
    } finally {
      polling = false;
    }
  };

  return {
    /**
     * Holds a tool call while a device decides.
     *
     * Returning without touching `output.status` leaves OpenCode's own prompt in
     * charge, which is what happens whenever the bridge is unreachable or the
     * call is not one the deck gates. Refusing by default would turn a bridge
     * outage into a session that cannot do anything.
     */
    "permission.ask": async (
      permission: {
        sessionID?: string;
        type?: string;
        title?: string;
        metadata?: JsonObject;
      },
      output: { status: "ask" | "deny" | "allow" },
    ) => {
      const session = permission.sessionID;
      // A child's approval stays with OpenCode's own prompt. The deck holds one
      // pending approval at a time, and a parent and a child asking at once
      // would fight over it.
      if (!session || subagents.isChild(session)) return;
      adopt(session);

      const tool = permission.type ?? "tool";
      const args = permission.metadata ?? {};
      if (!requiresApproval(tool, args, approvalMode)) return;

      const detail = permission.title ?? describeToolCall(tool, args);
      const requestId = crypto.randomUUID();
      const previousTask = task;
      state = "waiting";
      task = clip(`Approval: ${tool} · ${detail}`, 180);
      await heartbeat();
      await publishRuntime(
        "request.opened",
        {
          kind: "approval",
          tool,
          detail,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
        },
        { id: `request-opened:${requestId}`, requestId, turnId: activeTurnId },
      );

      // Settled by the command loop, the same path a steering message uses, so a
      // phone's decision and a phone's message cannot race each other.
      const approved = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          if (pendingApproval?.id === requestId) {
            pendingApproval = undefined;
            resolve(false);
          }
        }, APPROVAL_TIMEOUT_MS);
        pendingApproval = {
          id: requestId,
          toolName: tool,
          detail,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
          decide: resolve,
          timeout,
        };
      });

      state = "running";
      task = previousTask;
      await publishRuntime(
        "request.resolved",
        { status: approved ? "approved" : "rejected" },
        { id: `request-resolved:${requestId}`, requestId, turnId: activeTurnId },
      );
      await publish("output", approved ? `Approved: ${tool}` : `Rejected: ${tool}`, detail);
      // Only an explicit allow is written back. A timeout leaves the status
      // alone so OpenCode falls through to asking in the terminal, rather than
      // denying work nobody actually refused.
      if (approved) output.status = "allow";
      await heartbeat();
    },

    // The arguments are typed as what OpenCode actually hands over: plain
    // JSON, narrowed at the boundary like every other payload field.
    "tool.execute.before": async (
      call: { tool?: string; sessionID?: string; callID?: string },
      output: { args?: JsonValue },
    ) => {
      const route = routeFor(call.sessionID);
      if (!route) return;
      const tool = call.tool ?? "tool";
      const args = asObject(output.args);
      const path = absoluteTarget(args);
      // The file still holds its old contents here; remember them so the
      // completion can publish a real unified diff instead of a wall of `+`.
      // An absent target is remembered as empty, so a genuinely new file still
      // diffs cleanly as an addition against nothing.
      const before = mutatesFile(tool, path)
        ? existsSync(path)
          ? readFileForDiff(path)
          : ""
        : undefined;
      liveCalls.set(`${call.sessionID}:${call.callID}`, {
        command: shellCommand(tool, args),
        path,
        before,
        coarse: coarseDiff(tool, args),
      });
      if (!route.fromChild) {
        state = "running";
        task = `Using ${tool}`;
      }
      await publishRuntime(
        "item.started",
        { tool, summary: `Using ${tool}` },
        {
          id: `item-started:${call.sessionID}:${call.callID}`,
          itemId: call.callID,
          turnId: activeTurnId,
        },
      );
    },

    "tool.execute.after": async (
      call: { tool?: string; sessionID?: string; callID?: string; args?: JsonValue },
      result: { title?: string; output?: string },
    ) => {
      const route = routeFor(call.sessionID);
      if (!route) return;
      const tool = call.tool ?? "tool";
      const summary = `${tool} completed`;
      const callKey = `${call.sessionID}:${call.callID}`;
      const live = liveCalls.get(callKey);
      liveCalls.delete(callKey);
      // The before hook usually captured the facts; a call this plugin never
      // saw start still names its command and target from the arguments the
      // completion carries.
      const args = live ? undefined : asObject(call.args);
      const rawCommand = live ? live.command : shellCommand(tool, args);
      const command = rawCommand ? clipMultiline(rawCommand, 8_000) : undefined;
      const path = live ? live.path : absoluteTarget(args);
      const coarse = live ? live.coarse : coarseDiff(tool, args);
      let diff: string | undefined;
      if (live?.path !== undefined && live?.before !== undefined) {
        const after = live.before === null ? null : readFileForDiff(live.path);
        const unified =
          live.before !== null && after !== null ? unifiedDiff(live.before, after) : null;
        // "" means the tool touched nothing; null means too large or too
        // dissimilar to diff cheaply, which is when the coarse fallback earns
        // its keep.
        if (unified !== null) diff = unified === "" ? undefined : clipMultiline(unified, 16_000);
        else if (coarse) diff = clipMultiline(coarse, 16_000);
      } else if (coarse && mutatesFile(tool, path)) {
        diff = clipMultiline(coarse, 16_000);
      }
      if (!route.fromChild) task = summary;
      await publishRuntime(
        "item.completed",
        { tool, summary, path, command, diff },
        {
          id: `item-completed:${call.sessionID}:${call.callID}`,
          itemId: call.callID,
          turnId: activeTurnId,
        },
      );
      await publish("output", summary, text(result.title) ?? text(result.output), {
        id: `tool:${call.sessionID}:${call.callID}`,
        tool,
        path,
        command,
        diff,
        ...route.tags,
      });
    },

    /**
     * A new user message begins a turn. `chat.message` does not fire for a
     * one-shot `opencode run`, but for an interactive session it is the one
     * place the person's own words are visible, so the deck can name what the
     * session was actually asked.
     */
    "chat.message": async (
      message: { sessionID?: string },
      output: {
        message?: { id?: string; sessionID?: string };
        parts?: Array<{ type?: string; text?: string }>;
      },
    ) => {
      const session = message.sessionID ?? output.message?.sessionID;
      const route = routeFor(session);
      if (!route) return;
      const words = (output.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      // The message's own parts arrive again through message.part.updated;
      // remembering the id is what keeps the prompt from being re-published as
      // assistant output there.
      if (output.message?.id) userMessageIds.add(output.message.id);
      if (route.fromChild) return;
      objective = clip(words || "Received instruction", 500);
      task = clip(words || "Received instruction", 180);
      state = "running";
      activeTurnId = crypto.randomUUID();
      await publishRuntime("turn.started", { objective }, { turnId: activeTurnId });
      // The prompt is a message the person sent, so it lands on the
      // conversation side as one - not as a thought paraphrasing it.
      if (words) {
        await publish("user", "Message", words, {
          id: output.message?.id ? `user:${session}:${output.message.id}` : undefined,
        });
      }
      await heartbeat();
    },

    /**
     * Reads the model, and nothing else.
     *
     * `chat.params` rather than `chat.message`, which does not fire for a
     * one-shot `opencode run` at all - the model would have stayed the literal
     * word "OpenCode" for every non-interactive session. This one fires before
     * every model call. `output` is deliberately untouched: this hook exists to
     * change sampling parameters, and reading from it is the whole intent here.
     */
    "chat.params": async (params: {
      sessionID?: string;
      model?: { id?: string; providerID?: string };
      provider?: { info?: { id?: string } };
    }) => {
      // A subagent may run a different model; the card names the parent's.
      if (!params.sessionID || subagents.isChild(params.sessionID)) return;
      adopt(params.sessionID);
      const name = params.model?.id;
      if (name)
        model = `${params.provider?.info?.id ?? params.model?.providerID ?? "opencode"}/${name}`;
      await reportState("running");
      await heartbeat();
    },

    event: async ({ event }: { event: { type?: string; properties?: JsonObject } }) => {
      const properties = event.properties ?? {};
      // Parentage arrives once, on the session event that creates the child;
      // every later event about that session carries only its id. Only session
      // events are read for it - an assistant message also carries an `id` and
      // a `parentID`, but those name messages, not sessions.
      if (event.type?.startsWith("session.")) subagents.observe(properties.info);
      const info = asObject(properties.info);
      const part = asObject(properties.part);
      // Session events name their session at the top level; message and part
      // events name it inside the message or the part.
      const session = text(properties.sessionID) ?? text(info?.sessionID) ?? text(part?.sessionID);
      const route = routeFor(session);
      if (!route || !session) return;

      switch (event.type) {
        case "message.updated": {
          // Usage rides here; the assistant's words ride separately on
          // message.part.updated below.
          const role = asString(info?.role);
          const messageId = asString(info?.id);
          if (role === "user") {
            if (messageId) userMessageIds.add(messageId);
            break;
          }
          if (role !== "assistant") break;
          // Updates repeat while a message streams; spend is counted once,
          // when the message reports itself finished.
          const finished = isJsonObject(info?.time) && info.time.completed !== undefined;
          if (!finished || !messageId || accountedMessageIds.has(messageId)) break;
          const usage = isJsonObject(info?.tokens) ? info.tokens : undefined;
          const cache = isJsonObject(usage?.cache) ? usage.cache : undefined;
          const inputTokens = Number(usage?.input ?? 0);
          const outputTokens = Number(usage?.output ?? 0);
          const reasoningTokens = Number(usage?.reasoning ?? 0);
          const cacheTokens = Number(cache?.read ?? 0) + Number(cache?.write ?? 0);
          const turnTokens = inputTokens + outputTokens + reasoningTokens + cacheTokens;
          if (Number.isFinite(turnTokens) && turnTokens > 0) {
            accountedMessageIds.add(messageId);
            // A subagent's spend is real spend, but context pressure belongs
            // to the parent's own conversation.
            if (!route.fromChild) tokens = turnTokens;
            processedTokens += turnTokens;
            const reportedCost = Number(info?.cost ?? 0);
            if (Number.isFinite(reportedCost)) costUsd += reportedCost;
            await publishRuntime(
              "token-usage.updated",
              { contextTokens: tokens, processedTokens },
              { turnId: activeTurnId },
            );
          }
          break;
        }
        case "message.part.updated": {
          const kind = asString(part?.type);
          const messageId = asString(part?.messageID);
          // The person's own parts already landed as a user event.
          if (messageId && userMessageIds.has(messageId)) break;
          const stream = streamOf(session);
          if (kind === "reasoning") {
            const reasoning = text(part?.text);
            if (!reasoning) break;
            const now = Date.now();
            if (now - stream.lastReasoningAt < STREAMING_PUBLISH_INTERVAL_MS) break;
            stream.lastReasoningAt = now;
            if (!stream.reasoningId) stream.reasoningId = crypto.randomUUID();
            await publish("thought", "Reasoning", reasoning, {
              id: stream.reasoningId,
              ...route.tags,
            });
          } else if (kind === "text") {
            const response = text(part?.text);
            if (!response) break;
            const now = Date.now();
            if (now - stream.lastTextAt < STREAMING_PUBLISH_INTERVAL_MS) break;
            stream.lastTextAt = now;
            if (!stream.textId) stream.textId = crypto.randomUUID();
            await publish("output", "Response", response, { id: stream.textId, ...route.tags });
          }
          break;
        }
        case "session.idle":
          streams.delete(session);
          // A subagent going idle is its own errand ending, never the turn's;
          // letting it through was what once marked a working parent idle.
          if (route.fromChild) break;
          state = "idle";
          task = "Ready for a remote instruction";
          // Heartbeat first. The bridge treats it as authoritative and uses the
          // projection only where the two agree, so if the process exits between
          // the two calls it is the heartbeat that must already have landed -
          // otherwise a finished session is left reading as running.
          await heartbeat();
          await publishRuntime(
            "turn.completed",
            { status: "completed", summary: task },
            { turnId: activeTurnId },
          );
          activeTurnId = undefined;
          break;
        case "session.error":
          if (route.fromChild) {
            // The parent decides what a failed subagent means for the turn.
            await publish("error", "Subagent session error", undefined, route.tags);
            break;
          }
          state = "error";
          task = "Session error";
          await publishRuntime("runtime.error", { message: task });
          await publish("error", task);
          break;
        case "session.status": {
          if (route.fromChild) break;
          // The tested half of this pair used to be the only half: the
          // function ran, its result was written to a variable the bridge
          // discarded, and the status never reached the deck.
          const next = stateFromStatus(properties.status);
          if (next && state !== "waiting") await reportState(next);
          break;
        }
        default:
          return;
      }
      await heartbeat();
    },
  };
};

export default AgentDeckPlugin;
