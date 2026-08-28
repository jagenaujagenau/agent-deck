import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import {
  AgentDeckClient,
  clip,
  type AgentState,
  type EventKind,
  type RemoteCommand,
} from "../../packages/agent-adapter/src/index";
import {
  describeToolCall,
  normalizeApprovalMode,
  requiresApproval,
  usesRemoteApproval,
  type ApprovalMode,
} from "./approval-policy";
import { mutatesFile, readFileForDiff } from "../../packages/agent-adapter/src/file-snapshot";
import type {
  CanonicalRuntimeEvent,
  RuntimeEventType,
} from "../../packages/agent-adapter/src/runtime-events";
import { unifiedDiff } from "../../packages/agent-adapter/src/unified-diff";
import { asObject, asString, type JsonValue } from "./payload";
import { askedQuestion, isAskUserQuestionTool } from "./questions";
import {
  changedPaths,
  diffForPath,
  fingerprintWorkspace,
  type WorkspaceFingerprint,
} from "./workspace-changes";

const HEARTBEAT_INTERVAL_MS = 10_000;
const COMMAND_INTERVAL_MS = 2_000;
/**
 * How long a question waits for a remote answer before the host terminal takes over. The tool's own
 * prompt cannot appear while this blocks, so a long window hides the question from whoever is at the
 * terminal. Keep it short by default; raise it when nobody is at the machine, or 0 to never wait.
 */
const QUESTION_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.AGENT_DECK_QUESTION_TIMEOUT_MS ?? 30_000) || 0,
);

/**
 * `/reload` builds a fresh module scope, so the outgoing extension instance is unreachable through
 * module state. A well-known global is the only channel left for handing the live session over.
 */
const RELOAD_HANDOFF = Symbol.for("agent-deck.pi.reload-handoff");
type ReloadHandoff = {
  owner: string;
  stop: () => void;
  context: () => ExtensionContext | undefined;
};
// SAFETY: widens globalThis with one optional slot under a registry-scoped
// symbol; the symbol names this extension alone, so nothing else can claim the
// key with a different value.
const handoffSlot = globalThis as typeof globalThis & { [RELOAD_HANDOFF]?: ReloadHandoff };

const bridge = new AgentDeckClient();
/** Contents of each file a tool is about to rewrite, captured at execution start and diffed at end. */
const pendingFileEdits = new Map<string, { target: string; before: string }>();
const MAX_PENDING_FILE_EDITS = 64;
/** Workspace state as each shell command starts, compared once it ends to see what it touched. */
const pendingShellCommands = new Map<string, { cwd: string; before: WorkspaceFingerprint }>();
const MAX_PENDING_SHELL_COMMANDS = 16;

/** Pi's shell tools: their edits arrive as opaque command text, never as a named target path. */
const isShellTool = (toolName: string) => /^(bash|powershell|shell|run|terminal)/i.test(toolName);

type UsageTotals = { tokens: number; costUsd: number };

/** What a deck event can carry beyond its summary and detail. */
type EventDetails = {
  tool?: string;
  path?: string;
  command?: string;
  diff?: string;
  options?: ReadonlyArray<string>;
};

function clipMultiline(value: string, limit = 64_000): string {
  const text = value.replace(/\r\n?/g, "\n").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function contentOfType(
  content: JsonValue | undefined,
  type: "text" | "thinking",
  field: "text" | "thinking",
): string {
  const inline = asString(content);
  if (inline !== undefined) return type === "text" ? inline : "";
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const item = asObject(part);
      if (item === undefined) return [];
      const value = asString(item[field]);
      return item.type === type && value !== undefined ? [value] : [];
    })
    .join("\n");
}

const textContent = (content: JsonValue | undefined) => contentOfType(content, "text", "text");
const reasoningContent = (content: JsonValue | undefined) =>
  contentOfType(content, "thinking", "thinking");

function usageTotals(ctx: ExtensionContext): UsageTotals {
  let tokens = 0;
  let costUsd = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    tokens += usage?.totalTokens ?? 0;
    costUsd += usage?.cost?.total ?? 0;
  }
  return { tokens, costUsd };
}

function lastUserTask(ctx: ExtensionContext): string {
  const entries = [...ctx.sessionManager.getBranch()].reverse();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const text = clip(textContent(entry.message.content));
      if (text) return text;
    }
  }
  return "Ready for a remote instruction";
}

const bridgeRequest = <T>(path: string, init: RequestInit = {}) => bridge.request<T>(path, init);

export default function agentDeckExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let state: AgentState = "idle";
  let task = "Ready for a remote instruction";
  let objective: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let commandTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let connected = false;
  let approvalMode: ApprovalMode = normalizeApprovalMode(process.env.AGENT_DECK_APPROVAL_MODE);
  let streamingEventId: string | undefined;
  let streamingReasoningEventId: string | undefined;
  let activeTurnId: string | undefined;
  let streamingText = "";
  let streamingReasoning = "";
  let lastStreamingPublishAt = 0;
  let lastReasoningPublishAt = 0;
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

  const agentId = () =>
    ctx?.sessionManager.getSessionId() ?? process.env.PI_SESSION_ID ?? "pi-unknown";

  const modelName = () => {
    const model = ctx?.model;
    return model ? `${model.provider}/${model.id}` : "Pi";
  };

  const heartbeat = async () => {
    if (!ctx) return;
    const usage = usageTotals(ctx);
    try {
      await bridgeRequest("/agents/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          id: agentId(),
          name: pi.getSessionName() ?? `Pi · ${basename(ctx.cwd)}`,
          project: basename(ctx.cwd),
          model: modelName(),
          runtime: "pi",
          runtimeProtocol: "canonical-v1",
          state,
          task,
          objective,
          tokens: usage.tokens,
          processedTokens: usage.tokens,
          costUsd: usage.costUsd,
          capabilities: [
            "pause",
            "resume",
            "stop",
            ...(usesRemoteApproval(approvalMode) ? ["approve", "reject"] : []),
            "prompt",
            "steer",
            "follow_up",
          ],
          pendingApproval: pendingApproval
            ? {
                id: pendingApproval.id,
                tool: pendingApproval.toolName,
                detail: pendingApproval.detail,
                createdAt: pendingApproval.createdAt,
                expiresAt: pendingApproval.expiresAt,
              }
            : undefined,
        }),
      });
      connected = true;
      ctx.ui.setStatus(
        "agent-deck",
        ctx.ui.theme.fg("success", `● Agent Deck · gate ${approvalMode}`),
      );
    } catch {
      if (connected) connected = false;
      ctx.ui.setStatus(
        "agent-deck",
        ctx.ui.theme.fg("warning", `○ Agent Deck · gate ${approvalMode}`),
      );
    }
  };

  const publishRuntime = (
    type: RuntimeEventType,
    payload: CanonicalRuntimeEvent["payload"],
    refs: { id?: string; turnId?: string; itemId?: string; requestId?: string } = {},
  ) => {
    if (!ctx) return Promise.resolve();
    const body: CanonicalRuntimeEvent = {
      id: refs.id ?? crypto.randomUUID(),
      agentId: agentId(),
      type,
      createdAt: new Date().toISOString(),
      payload,
    };
    if (refs.turnId) body.turnId = refs.turnId;
    if (refs.itemId) body.itemId = refs.itemId;
    if (refs.requestId) body.requestId = refs.requestId;
    return bridgeRequest(`/agents/${encodeURIComponent(agentId())}/runtime-events`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  };

  const publishEvent = (
    kind: EventKind,
    summary: string,
    detail?: string,
    id?: string,
    extra: EventDetails = {},
  ) => {
    if (!ctx) return;
    void bridgeRequest(`/agents/${encodeURIComponent(agentId())}/events`, {
      method: "POST",
      body: JSON.stringify({
        id,
        kind,
        summary: clip(summary, 120),
        detail: detail ? clipMultiline(detail) : undefined,
        ...extra,
      }),
    }).catch(() => {});
  };

  const acknowledge = async (commandId: string) => {
    await bridgeRequest(
      `/agents/${encodeURIComponent(agentId())}/commands/${encodeURIComponent(commandId)}/ack`,
      { method: "POST" },
    );
  };

  const settleApproval = (approved: boolean) => {
    const pending = pendingApproval;
    if (!pending) return false;
    pendingApproval = undefined;
    clearTimeout(pending.timeout);
    pending.decide(approved);
    return true;
  };

  const requestApproval = async (
    toolName: string,
    detail: string,
    nextCtx: ExtensionContext,
  ): Promise<boolean> => {
    if (pendingApproval) return false;
    adopt(nextCtx);
    const previousTask = task;
    state = "waiting";
    task = `Approval required: ${toolName}`;
    const approvalId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const approvedPromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        if (pendingApproval?.id === approvalId) {
          pendingApproval = undefined;
          resolve(false);
        }
      }, 10 * 60_000);
      pendingApproval = {
        id: approvalId,
        toolName,
        detail,
        createdAt,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        decide: resolve,
        timeout,
      };
    });
    publishEvent("warning", task, detail, approvalId, { tool: toolName });
    await heartbeat();
    await publishRuntime(
      "request.opened",
      {
        kind: "approval",
        tool: toolName,
        detail,
        createdAt,
        expiresAt: pendingApproval!.expiresAt,
      },
      { id: `request-opened:${approvalId}`, requestId: approvalId, turnId: activeTurnId },
    );
    const approved = await approvedPromise;

    state = approved ? "running" : "idle";
    task = previousTask;
    await publishRuntime(
      "request.resolved",
      { status: approved ? "approved" : "rejected" },
      { id: `request-resolved:${approvalId}`, requestId: approvalId, turnId: activeTurnId },
    ).catch(() => {});
    publishEvent(
      approved ? "output" : "warning",
      approved ? `Approved: ${toolName}` : `Rejected: ${toolName}`,
      detail,
    );
    void heartbeat();
    return approved;
  };

  const executeCommand = async (command: RemoteCommand) => {
    if (!ctx) return;
    try {
      switch (command.action) {
        case "prompt":
        case "steer":
        case "follow_up": {
          if (!command.value?.trim()) throw new Error("Remote prompt was empty");
          task = clip(command.value);
          objective = clip(command.value, 500);
          state = "running";
          const delivery = command.action === "follow_up" ? "followUp" : "steer";
          pi.sendUserMessage(command.value, ctx.isIdle() ? undefined : { deliverAs: delivery });
          break;
        }
        case "pause":
          settleApproval(false);
          ctx.abort();
          state = "paused";
          task = "Paused remotely";
          break;
        case "resume":
          state = "running";
          task = "Resuming interrupted work";
          pi.sendUserMessage(
            "Continue from where you were interrupted.",
            ctx.isIdle() ? undefined : { deliverAs: "followUp" },
          );
          break;
        case "stop":
          settleApproval(false);
          ctx.abort();
          state = "idle";
          task = "Stopped remotely";
          break;
        case "approve":
          if (!settleApproval(true)) {
            state = "running";
            task = "Remote approval received";
            pi.sendUserMessage(
              "Approved from Agent Deck. Proceed.",
              ctx.isIdle() ? undefined : { deliverAs: "steer" },
            );
          }
          break;
        case "reject":
          if (!settleApproval(false)) {
            ctx.abort();
            state = "idle";
            task = "Remote request rejected";
            pi.sendUserMessage(
              "Rejected from Agent Deck. Do not perform the pending action.",
              ctx.isIdle() ? undefined : { deliverAs: "steer" },
            );
          }
          break;
      }
      publishEvent("output", `Remote command: ${command.action}`, command.value);
    } catch (error) {
      state = "error";
      publishEvent(
        "error",
        `Remote command failed: ${command.action}`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await acknowledge(command.id).catch(() => {});
      void heartbeat();
    }
  };

  const pollCommands = async () => {
    if (!ctx || polling) return;
    polling = true;
    try {
      const result = await bridgeRequest<{ commands: RemoteCommand[] }>(
        `/agents/${encodeURIComponent(agentId())}/commands`,
      );
      for (const command of result.commands) await executeCommand(command);
    } catch {
      // Heartbeats own the visible connection status; command polling is best-effort.
    } finally {
      polling = false;
    }
  };

  const instanceToken = crypto.randomUUID();

  const stopLoops = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (commandTimer) clearInterval(commandTimer);
    heartbeatTimer = undefined;
    commandTimer = undefined;
  };

  /**
   * Adopts the newest context and guarantees the heartbeat and command loops are running. Every
   * handler routes through here because `session_start` does not fire again after a `/reload`, so
   * it is no longer the only place a connection can begin.
   */
  const adopt = (nextCtx: ExtensionContext) => {
    ctx = nextCtx;
    if (!heartbeatTimer)
      heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
    if (!commandTimer) commandTimer = setInterval(() => void pollCommands(), COMMAND_INTERVAL_MS);
  };

  // Take over from whatever instance a `/reload` is replacing: stop its loops so the two do not
  // both heartbeat, and inherit its context so the session stays connected without waiting for the
  // next event. Claiming ownership also tells the outgoing instance not to publish "offline".
  // The handoff is process-scoped, matching this file's existing assumption of one Pi session per
  // process (see the PI_SESSION_ID fallback in agentId). If that ever stops holding, key the slot
  // by session id — a second concurrent session would otherwise adopt this one's context.
  const previous = handoffSlot[RELOAD_HANDOFF];
  previous?.stop();
  handoffSlot[RELOAD_HANDOFF] = { owner: instanceToken, stop: stopLoops, context: () => ctx };
  const inherited = previous?.context();
  if (inherited) {
    adopt(inherited);
    state = inherited.isIdle() ? "idle" : "running";
    task = lastUserTask(inherited);
    void heartbeat();
    void pollCommands();
  }

  pi.on("session_start", async (_event, nextCtx) => {
    adopt(nextCtx);
    state = nextCtx.isIdle() ? "idle" : "running";
    task = lastUserTask(nextCtx);
    objective = task == "Ready for a remote instruction" ? undefined : clip(task, 500);
    // Identity as an event, not only as a heartbeat field - see ADR-0001.
    await publishRuntime("session.registered", {
      name: pi.getSessionName() ?? `Pi · ${basename(nextCtx.cwd)}`,
      project: basename(nextCtx.cwd),
      model: modelName(),
      runtime: "pi",
      capabilities: ["approve", "reject", "steer", "prompt", "follow_up"],
    }).catch(() => {});
    await heartbeat();
    void pollCommands();
  });

  pi.on("before_agent_start", (event, nextCtx) => {
    adopt(nextCtx);
    state = "running";
    task = clip(event.prompt);
    objective = clip(event.prompt, 500);
    activeTurnId = crypto.randomUUID();
    void publishRuntime("turn.started", { objective }, { turnId: activeTurnId }).catch(() => {});
    // The prompt is the person's own message, so it is published as one - the phone renders it as
    // a user bubble, not as the agent thinking. One prompt opens one turn, so the turn id keys the
    // event: republishing lands on the same entry instead of doubling it.
    publishEvent("user", "Message", event.prompt, `user:${agentId()}:${activeTurnId}`);
    void heartbeat();
  });

  pi.on("agent_start", (_event, nextCtx) => {
    adopt(nextCtx);
    state = "running";
    void heartbeat();
  });

  pi.on("tool_call", async (event, nextCtx) => {
    adopt(nextCtx);
    const input = asObject(event.input) ?? {};
    if (isAskUserQuestionTool(event.toolName)) {
      const { question, options } = askedQuestion(input);
      if (options.length === 0 || QUESTION_TIMEOUT_MS === 0) {
        // No preset choices means nothing a phone or watch could safely answer with — show it and
        // let the host terminal take it.
        publishEvent("question", "Question", question, undefined, {
          tool: event.toolName,
          options,
        });
        return;
      }
      const questionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + QUESTION_TIMEOUT_MS).toISOString();
      state = "waiting";
      task = clip(question, 180);
      void publishRuntime(
        "user-input.requested",
        { kind: "user-input", question, options, createdAt: new Date().toISOString(), expiresAt },
        { id: `user-input-requested:${questionId}`, requestId: questionId, turnId: activeTurnId },
      ).catch(() => {});
      publishEvent("question", "Question", question, questionId, { tool: event.toolName, options });
      void heartbeat();
      const answer = await bridge
        .waitForAnswer(agentId(), questionId, { timeoutMs: QUESTION_TIMEOUT_MS })
        .catch(() => undefined);
      state = "running";
      if (answer === undefined) {
        task = clip(question, 180);
        void heartbeat();
        return; // Unanswered remotely — the tool asks on the host terminal as usual.
      }
      task = clip(`Answered: ${answer}`, 180);
      void publishRuntime(
        "user-input.resolved",
        { status: "answered", value: answer },
        { id: `user-input-resolved:${questionId}`, requestId: questionId, turnId: activeTurnId },
      ).catch(() => {});
      publishEvent("output", "Answered from Agent Deck", answer);
      void heartbeat();
      return {
        block: true,
        reason: `The user answered from Agent Deck: ${answer}. Do not ask again — continue with that answer.`,
      };
    }
    if (!requiresApproval(event.toolName, input, approvalMode)) return;
    const detail = describeToolCall(event.toolName, input);
    const approved = await requestApproval(event.toolName, detail, nextCtx);
    if (!approved) return { block: true, reason: "Rejected or timed out in Agent Deck" };
  });

  pi.on("tool_execution_start", (event, nextCtx) => {
    adopt(nextCtx);
    const args = asObject(event.args) ?? {};
    // A question tool only gets this far when the deck could not take it: no
    // options to offer, or nobody answered in time. Reaching execution means it
    // is now asking the host terminal and the session is blocked on a person -
    // so saying "running" here described the one case that most needs saying.
    if (isAskUserQuestionTool(event.toolName)) {
      state = "waiting";
      task = clip(askedQuestion(args).question, 180);
    } else {
      state = "running";
    }
    // SAFETY: `toolCallId` rides on tool execution events at runtime but is not
    // part of the published event type; only that one optional field is read,
    // and a missing value falls back to a fresh id.
    const itemId = String((event as { toolCallId?: string }).toolCallId ?? crypto.randomUUID());
    const target = asString(args.file_path) ?? asString(args.path);
    // The tool has not run yet, so the file still holds its old contents. Keep them to diff against
    // once it completes, which turns a whole-file write into a real change instead of all additions.
    if (mutatesFile(event.toolName, target)) {
      const before = readFileForDiff(target);
      if (before !== null) {
        if (pendingFileEdits.size >= MAX_PENDING_FILE_EDITS)
          pendingFileEdits.delete(pendingFileEdits.keys().next().value!);
        pendingFileEdits.set(itemId, { target, before });
      }
    }
    // A shell command names no file to snapshot, so the workspace is asked instead: its state now,
    // held against its state when the command finishes, is the set of files the command touched.
    if (isShellTool(event.toolName)) {
      const before = fingerprintWorkspace(nextCtx.cwd);
      if (before) {
        if (pendingShellCommands.size >= MAX_PENDING_SHELL_COMMANDS)
          pendingShellCommands.delete(pendingShellCommands.keys().next().value!);
        pendingShellCommands.set(itemId, { cwd: nextCtx.cwd, before });
      }
    }
    const started = publishRuntime(
      "item.started",
      {
        tool: event.toolName,
        summary: `Using ${event.toolName}`,
        detail: describeToolCall(event.toolName, args),
      },
      { id: `item-started:${agentId()}:${itemId}`, itemId, turnId: activeTurnId },
    ).catch(() => {});
    // The deck reads this runtime's state from its event stream, and item.started
    // means "running" there. A blocked question therefore has to say so *after*
    // that lands: published side by side the two race, and the deck keeps
    // whichever arrived last. Chained, the answer is the same every time.
    if (isAskUserQuestionTool(event.toolName)) {
      const blocked = task;
      void started.then(() =>
        publishRuntime("session.state.changed", { state: "waiting", task: blocked }).catch(
          () => {},
        ),
      );
    } else {
      void started;
    }
    const command = asString(args.command);
    const removed = asString(args.old_string);
    const added = asString(args.new_string);
    const written = asString(args.content);
    publishEvent(
      "tool",
      `Using ${event.toolName}`,
      describeToolCall(event.toolName, args),
      `tool:${agentId()}:${itemId}`,
      {
        tool: event.toolName,
        path: target,
        command: command !== undefined ? clipMultiline(command, 8_000) : undefined,
        diff:
          removed !== undefined && added !== undefined
            ? clipMultiline(
                `- ${removed.replace(/\n/g, "\n- ")}\n+ ${added.replace(/\n/g, "\n+ ")}`,
                16_000,
              )
            : /write|create/i.test(event.toolName) && written !== undefined
              ? clipMultiline(`+ ${written.replace(/\n/g, "\n+ ")}`, 16_000)
              : undefined,
      },
    );
  });

  pi.on("tool_execution_end", (event, nextCtx) => {
    adopt(nextCtx);
    // SAFETY: `toolCallId` rides on tool execution events at runtime but is not
    // part of the published event type; only that one optional field is read,
    // and a missing value falls back to a fresh id.
    const itemId = String((event as { toolCallId?: string }).toolCallId ?? crypto.randomUUID());
    const summary = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
    // The terminal question has been answered, so the session is a running
    // agent again. Said here rather than left to the next tool call, which may
    // be a whole model response away.
    if (isAskUserQuestionTool(event.toolName)) state = "running";
    // Upgrade the coarse diff published at start to real unified hunks. The bridge merges by event
    // id, so this replaces the placeholder rather than appending a second entry.
    const pending = pendingFileEdits.get(itemId);
    pendingFileEdits.delete(itemId);
    const after = pending && !event.isError ? readFileForDiff(pending.target) : null;
    const unified = pending && after !== null ? unifiedDiff(pending.before, after) : null;
    // The workspace answered for this command at start; asking again now names every file the
    // command touched. A failed command has often already written before failing, so its changes
    // are reported too - with per-command snapshots there is no later baseline to catch them.
    const shell = pendingShellCommands.get(itemId);
    pendingShellCommands.delete(itemId);
    const workspaceNow = shell ? fingerprintWorkspace(shell.cwd) : undefined;
    if (shell && workspaceNow) {
      for (const changed of changedPaths(shell.before, workspaceNow)) {
        const body = diffForPath(shell.cwd, changed);
        if (!body) continue;
        const absolute = join(shell.cwd, changed);
        const changeSummary = `${event.toolName} changed ${basename(changed)}`;
        void publishRuntime(
          "item.completed",
          { tool: event.toolName, summary: changeSummary, path: absolute, diff: body },
          {
            id: `item-completed:${agentId()}:${itemId}:${changed}`,
            itemId: `${itemId}:${changed}`,
            turnId: activeTurnId,
          },
        ).catch(() => {});
        // The runtime event feeds the projection; this is what lands the diff in the session's
        // file history, which is what the Changes tab reads.
        publishEvent(
          "output",
          changeSummary,
          undefined,
          `shell-change:${agentId()}:${itemId}:${changed}`,
          {
            tool: event.toolName,
            path: absolute,
            diff: body,
          },
        );
      }
    }
    void publishRuntime(
      event.isError ? "runtime.error" : "item.completed",
      event.isError ? { message: summary } : { tool: event.toolName, summary },
      {
        id: `${event.isError ? "runtime-error" : "item-completed"}:${agentId()}:${itemId}`,
        itemId,
        turnId: activeTurnId,
      },
    ).catch(() => {});
    const completion: EventDetails = { tool: event.toolName };
    if (unified) completion.diff = clipMultiline(unified, 16_000);
    publishEvent(
      event.isError ? "error" : "output",
      summary,
      undefined,
      `tool:${agentId()}:${itemId}`,
      completion,
    );
    void heartbeat();
  });

  pi.on("message_start", (event, nextCtx) => {
    adopt(nextCtx);
    if (event.message.role !== "assistant") return;
    streamingEventId = crypto.randomUUID();
    streamingReasoningEventId = crypto.randomUUID();
    streamingText = "";
    streamingReasoning = "";
    lastStreamingPublishAt = 0;
    lastReasoningPublishAt = 0;
  });

  pi.on("message_update", (event, nextCtx) => {
    adopt(nextCtx);
    const update = event.assistantMessageEvent;
    const timestamp = Date.now();
    if (update.type === "text_delta") {
      streamingText += update.delta;
      if (!streamingEventId || timestamp - lastStreamingPublishAt < 250) return;
      lastStreamingPublishAt = timestamp;
      publishEvent("output", "Responding…", streamingText, streamingEventId);
    } else if (update.type === "thinking_delta") {
      streamingReasoning += update.delta;
      if (!streamingReasoningEventId || timestamp - lastReasoningPublishAt < 250) return;
      lastReasoningPublishAt = timestamp;
      publishEvent("thought", "Reasoning…", streamingReasoning, streamingReasoningEventId);
    }
  });

  pi.on("message_end", (event, nextCtx) => {
    adopt(nextCtx);
    if (event.message.role !== "assistant") return;
    const output = textContent(event.message.content);
    const reasoning = reasoningContent(event.message.content);
    if (reasoning) publishEvent("thought", "Reasoning", reasoning, streamingReasoningEventId);
    if (output) {
      publishEvent(
        event.message.stopReason === "error" ? "error" : "output",
        event.message.stopReason === "error" ? "Response failed" : "Response",
        output,
        streamingEventId,
      );
    }
    streamingEventId = undefined;
    streamingReasoningEventId = undefined;
    streamingText = "";
    streamingReasoning = "";
  });

  pi.on("agent_settled", (_event, nextCtx) => {
    adopt(nextCtx);
    state = "idle";
    if (task === "Paused remotely") state = "paused";
    const usage = usageTotals(nextCtx);
    void publishRuntime(
      "token-usage.updated",
      { contextTokens: usage.tokens, processedTokens: usage.tokens },
      { turnId: activeTurnId },
    ).catch(() => {});
    void publishRuntime(
      "turn.completed",
      { status: "completed", summary: task },
      { turnId: activeTurnId },
    ).catch(() => {});
    activeTurnId = undefined;
    void heartbeat();
  });

  pi.on("model_select", (_event, nextCtx) => {
    adopt(nextCtx);
    void heartbeat();
  });

  pi.on("session_info_changed", (_event, nextCtx) => {
    adopt(nextCtx);
    void heartbeat();
  });

  pi.on("session_shutdown", async (_event, nextCtx) => {
    stopLoops();
    settleApproval(false);
    // A `/reload` tears the outgoing instance down *after* its replacement is live. Publishing
    // "offline" for the shared agent id here is what dropped the session on the phone.
    if (handoffSlot[RELOAD_HANDOFF]?.owner !== instanceToken) return;
    handoffSlot[RELOAD_HANDOFF] = undefined;
    // Deliberately not adopt(): this is a real shutdown, and the loops must stay stopped.
    ctx = nextCtx;
    state = "offline";
    await publishRuntime("session.state.changed", {
      state: "offline",
      task: "Session ended",
    }).catch(() => {});
    await heartbeat();
    nextCtx.ui.setStatus("agent-deck", undefined);
    ctx = undefined;
  });

  pi.registerCommand("deck-gate", {
    description: "Set remote approval mode: off, destructive, or all",
    handler: async (args, commandCtx) => {
      const requested = args.trim();
      if (requested !== "off" && requested !== "destructive" && requested !== "all") {
        commandCtx.ui.notify(
          `Approval mode: ${approvalMode}. Usage: /deck-gate off|destructive|all`,
          "info",
        );
        return;
      }
      approvalMode = requested;
      if (!usesRemoteApproval(approvalMode)) settleApproval(true);
      adopt(commandCtx);
      await heartbeat();
      commandCtx.ui.notify(`Agent Deck approval mode: ${approvalMode}`, "info");
    },
  });

  pi.registerCommand("deck-test-approval", {
    description: "Send a harmless approval request to Agent Deck",
    handler: async (_args, commandCtx) => {
      const approved = await requestApproval(
        "test",
        "Harmless end-to-end approval test",
        commandCtx,
      );
      state = "idle";
      task = approved ? "Approval test completed" : "Approval test rejected";
      void heartbeat();
      commandCtx.ui.notify(
        approved ? "Remote approval received" : "Remote approval rejected or timed out",
        approved ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("deck-status", {
    description: "Show the Agent Deck bridge connection",
    handler: async (_args, commandCtx) => {
      adopt(commandCtx);
      await heartbeat();
      commandCtx.ui.notify(
        connected
          ? `Agent Deck connected to ${bridge.baseUrl}`
          : `Agent Deck cannot reach ${bridge.baseUrl}`,
        connected ? "info" : "warning",
      );
    },
  });
}
