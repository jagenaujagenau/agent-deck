import { basename } from "node:path";
import { AgentDeckClient, clip } from "../../packages/agent-adapter/src/client";
import {
  describeToolCall,
  requiresApproval,
} from "../../packages/agent-adapter/src/approval-policy";
import type { ApprovalMode } from "../../packages/agent-adapter/src/approval-policy";
import type { RuntimeEventType } from "../../packages/agent-adapter/src/runtime-events";
import { deckAgentId, stateFromStatus, SubagentSessions } from "./session";

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
 * tool exactly as it already can for Pi.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

const approvalMode: ApprovalMode = ["off", "destructive", "all"].includes(
  process.env.AGENT_DECK_APPROVAL_MODE ?? "",
)
  ? (process.env.AGENT_DECK_APPROVAL_MODE as ApprovalMode)
  : "destructive";

type Json = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export const AgentDeckPlugin = async (input: {
  project?: { id?: string };
  directory?: string;
  worktree?: string;
}) => {
  const client = new AgentDeckClient();
  const subagents = new SubagentSessions();
  // `worktree` is "/" for a directory OpenCode has no project for, and
  // basename("/") is the empty string - which reaches the deck as a session
  // with no name at all. The working directory is the honest fallback.
  const worktree = input.worktree && input.worktree !== "/" ? input.worktree : undefined;
  const projectName = basename(worktree ?? input.directory ?? process.cwd()) || "opencode";

  /**
   * The session this plugin instance is speaking for.
   *
   * OpenCode loads the plugin before any session exists, so this is filled in
   * by the first event that names one rather than taken from the input.
   */
  let sessionId: string | undefined;
  let state: "idle" | "running" | "waiting" | "error" = "idle";
  let task = "Ready for a remote instruction";
  let model = "OpenCode";
  let timer: ReturnType<typeof setInterval> | undefined;

  const agentId = () => (sessionId ? deckAgentId(sessionId) : undefined);

  const heartbeat = async () => {
    const id = agentId();
    if (!id) return;
    await client
      .heartbeat({
        id,
        name: `OpenCode · ${projectName} · ${sessionId!.slice(-4)}`,
        project: projectName,
        model,
        runtime: "opencode",
        runtimeProtocol: "canonical-v1",
        state,
        task,
        capabilities: ["approve", "reject"],
      })
      .catch(() => {});
  };

  const publishRuntime = async (
    type: RuntimeEventType,
    payload: Json,
    refs: { id?: string; turnId?: string; itemId?: string; requestId?: string } = {},
  ) => {
    const id = agentId();
    if (!id) return;
    await client
      .runtimeEvent({
        id: refs.id ?? crypto.randomUUID(),
        agentId: id,
        type,
        createdAt: new Date().toISOString(),
        payload,
        ...refs,
      })
      .catch(() => {});
  };

  const publish = async (
    kind: "output" | "warning" | "error" | "tool",
    summary: string,
    detail?: string,
    extra: Json = {},
  ) => {
    const id = agentId();
    if (!id) return;
    await client.event(id, { kind, summary: clip(summary, 120), detail, ...extra }).catch(() => {});
  };

  /** Starts the heartbeat once there is a session worth reporting. */
  const adopt = (nextSessionId: string) => {
    if (sessionId !== nextSessionId) {
      sessionId = nextSessionId;
      void heartbeat();
    }
    if (!timer) timer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
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
        metadata?: Record<string, unknown>;
      },
      output: { status: "ask" | "deny" | "allow" },
    ) => {
      const session = permission.sessionID;
      if (!session || subagents.shouldDrop(session)) return;
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
        { id: `request-opened:${requestId}`, requestId },
      );

      const approved = await client
        .waitForDecision(agentId()!, { timeoutMs: APPROVAL_TIMEOUT_MS })
        .catch(() => false);

      state = "running";
      task = previousTask;
      await publishRuntime(
        "request.resolved",
        { status: approved ? "approved" : "rejected" },
        { id: `request-resolved:${requestId}`, requestId },
      );
      await publish("output", approved ? `Approved: ${tool}` : `Rejected: ${tool}`, detail);
      // Only an explicit allow is written back. A timeout leaves the status
      // alone so OpenCode falls through to asking in the terminal, rather than
      // denying work nobody actually refused.
      if (approved) output.status = "allow";
      await heartbeat();
    },

    "tool.execute.before": async (
      call: { tool?: string; sessionID?: string; callID?: string },
      _output: { args: unknown },
    ) => {
      if (!call.sessionID || subagents.shouldDrop(call.sessionID)) return;
      adopt(call.sessionID);
      state = "running";
      task = `Using ${call.tool ?? "tool"}`;
      await publishRuntime(
        "item.started",
        { tool: call.tool, summary: task },
        { id: `item-started:${call.sessionID}:${call.callID}`, itemId: call.callID },
      );
    },

    "tool.execute.after": async (
      call: { tool?: string; sessionID?: string; callID?: string; args?: unknown },
      result: { title?: string; output?: string },
    ) => {
      if (!call.sessionID || subagents.shouldDrop(call.sessionID)) return;
      adopt(call.sessionID);
      const summary = `${call.tool ?? "Tool"} completed`;
      task = summary;
      await publishRuntime(
        "item.completed",
        { tool: call.tool, summary },
        { id: `item-completed:${call.sessionID}:${call.callID}`, itemId: call.callID },
      );
      await publish("output", summary, text(result.title) ?? text(result.output), {
        id: `tool:${call.sessionID}:${call.callID}`,
        tool: call.tool,
      });
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
      if (!params.sessionID || subagents.shouldDrop(params.sessionID)) return;
      adopt(params.sessionID);
      const name = params.model?.id;
      if (name)
        model = `${params.provider?.info?.id ?? params.model?.providerID ?? "opencode"}/${name}`;
      state = "running";
      await heartbeat();
    },

    event: async ({ event }: { event: { type?: string; properties?: Json } }) => {
      const properties = event.properties ?? {};
      // Parentage arrives once, on the event that creates the child; every
      // later event about that session carries only its id.
      subagents.observe(properties.info);
      const session = text(properties.sessionID);
      if (!session || subagents.shouldDrop(session)) return;
      adopt(session);

      switch (event.type) {
        case "session.idle":
          state = "idle";
          task = "Ready for a remote instruction";
          // Heartbeat first. The bridge treats it as authoritative and uses the
          // projection only where the two agree, so if the process exits between
          // the two calls it is the heartbeat that must already have landed -
          // otherwise a finished session is left reading as running.
          await heartbeat();
          await publishRuntime("turn.completed", { status: "completed", summary: task });
          break;
        case "session.error":
          state = "error";
          task = "Session error";
          await publishRuntime("runtime.error", { message: task });
          await publish("error", task);
          break;
        case "session.status": {
          const next = stateFromStatus(properties.status);
          if (next && state !== "waiting") state = next;
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
