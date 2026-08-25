import type { CanonicalRuntimeEvent, RuntimeRequestStatus } from "./runtime-events";

export type RuntimeProjection = {
  agentId: string;
  sequence: number;
  /**
   * Who this session is, as the runtime declared itself.
   *
   * Absent until a `session.registered` event arrives. The heartbeat was the
   * only carrier of identity, which is the single reason it had to stay: a
   * projection that cannot say what a session is called cannot replace a
   * document that can. ADR-0001 names this as the migration's exit condition.
   */
  identity?: {
    name: string;
    project: string;
    model: string;
    runtime?: string;
    capabilities?: ReadonlyArray<string>;
  };
  state: "idle" | "running" | "waiting" | "error" | "offline";
  task: string;
  activeTurnId?: string;
  activeItemId?: string;
  pendingRequest?: {
    id: string;
    kind: "approval" | "user-input";
    status: RuntimeRequestStatus;
    payload: Record<string, unknown>;
  };
  contextTokens: number;
  processedTokens: number;
  usageKnown: boolean;
  updatedAt: string;
};

export function emptyRuntimeProjection(agentId: string): RuntimeProjection {
  return {
    agentId,
    sequence: 0,
    state: "idle",
    task: "Ready",
    contextTokens: 0,
    processedTokens: 0,
    usageKnown: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export function projectRuntimeEvent(
  current: RuntimeProjection,
  event: CanonicalRuntimeEvent,
  sequence: number,
): RuntimeProjection {
  if (event.agentId !== current.agentId || sequence <= current.sequence) return current;
  const next = { ...current, sequence, updatedAt: event.createdAt };
  switch (event.type) {
    case "session.registered":
      return {
        ...next,
        identity: {
          name: text(event.payload.name) ?? current.identity?.name ?? current.agentId,
          project: text(event.payload.project) ?? current.identity?.project ?? "",
          model: text(event.payload.model) ?? current.identity?.model ?? "",
          runtime: text(event.payload.runtime) ?? current.identity?.runtime,
          capabilities: Array.isArray(event.payload.capabilities)
            ? (event.payload.capabilities as ReadonlyArray<string>)
            : current.identity?.capabilities,
        },
        // Registration says who, not what it is doing. A session that
        // re-registers after a reconnect has not gone back to idle.
        state: current.sequence === 0 ? next.state : current.state,
        task: current.sequence === 0 ? next.task : current.task,
      };
    case "session.state.changed":
      return {
        ...next,
        state: state(event.payload.state),
        task: text(event.payload.task) ?? current.task,
      };
    case "turn.started":
      return {
        ...next,
        state: "running",
        activeTurnId: event.turnId,
        task: text(event.payload.objective) ?? "Working",
      };
    case "turn.completed":
      return {
        ...next,
        state: event.payload.status === "failed" ? "error" : "idle",
        activeTurnId: undefined,
        activeItemId: undefined,
        task: text(event.payload.summary) ?? "Turn completed",
      };
    case "request.opened":
    case "user-input.requested":
      return event.requestId
        ? {
            ...next,
            state: "waiting",
            pendingRequest: {
              id: event.requestId,
              kind: event.type === "request.opened" ? "approval" : "user-input",
              status: "pending",
              payload: event.payload,
            },
          }
        : next;
    case "request.resolved":
    case "user-input.resolved":
      return {
        ...next,
        // A settled request means the question is answered, not that the
        // session went back to work. Usually it did - the blocked call resumes -
        // but a request that expired unanswered leaves the runtime exactly where
        // it was, and saying "running" there reported sessions as busy while
        // they sat at a prompt.
        state:
          event.payload.status === "answered" || event.payload.status === "approved"
            ? "running"
            : current.state,
        pendingRequest: undefined,
      };
    case "item.started":
    case "item.updated":
      return {
        ...next,
        state: "running",
        activeItemId: event.itemId,
        task: text(event.payload.summary) ?? text(event.payload.tool) ?? "Working",
      };
    case "item.completed":
      return {
        ...next,
        // A finished item does not mean work is happening - it means some
        // finished. On a session whose turn has already completed this is late
        // news, and claiming "running" for it resurrected sessions that were
        // sitting idle: a Task subagent can outlive the turn that dispatched
        // it, so its completion lands minutes after `turn.completed`.
        //
        // `item.started` still moves a session to running, because work
        // beginning genuinely is work happening.
        state: current.state === "idle" ? "idle" : "running",
        activeItemId: undefined,
        task: text(event.payload.summary) ?? "Tool completed",
      };
    case "token-usage.updated":
      return {
        ...next,
        contextTokens: count(event.payload.contextTokens, current.contextTokens),
        processedTokens: Math.max(
          current.processedTokens,
          count(event.payload.processedTokens, current.processedTokens),
        ),
        usageKnown: true,
      };
    case "runtime.error":
      return { ...next, state: "error", task: text(event.payload.message) ?? "Runtime error" };
    case "rate-limits.updated":
      return next;
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function count(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}
function state(value: unknown): RuntimeProjection["state"] {
  return value === "running" || value === "waiting" || value === "error" || value === "offline"
    ? value
    : "idle";
}
