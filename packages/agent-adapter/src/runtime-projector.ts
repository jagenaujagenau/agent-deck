import type { CanonicalRuntimeEvent, RuntimeRequestStatus } from "./runtime-events";

export type RuntimeProjection = {
  agentId: string;
  sequence: number;
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
      return { ...next, state: "running", pendingRequest: undefined };
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
        state: "running",
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
