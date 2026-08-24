export type RuntimeEventType =
  | "session.state.changed"
  | "turn.started"
  | "turn.completed"
  | "request.opened"
  | "request.resolved"
  | "user-input.requested"
  | "user-input.resolved"
  | "item.started"
  | "item.updated"
  | "item.completed"
  | "token-usage.updated"
  | "rate-limits.updated"
  | "runtime.error";

export type RuntimeRequestKind = "approval" | "user-input";
export type RuntimeRequestStatus = "pending" | "approved" | "rejected" | "answered" | "expired" | "unavailable";

export type CanonicalRuntimeEvent = {
  id: string;
  agentId: string;
  type: RuntimeEventType;
  createdAt: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  payload: Record<string, unknown>;
};

const eventTypes = new Set<RuntimeEventType>([
  "session.state.changed", "turn.started", "turn.completed", "request.opened", "request.resolved",
  "user-input.requested", "user-input.resolved", "item.started", "item.updated", "item.completed",
  "token-usage.updated", "rate-limits.updated", "runtime.error",
]);

export function canonicalRuntimeEvent(value: unknown): CanonicalRuntimeEvent {
  if (typeof value !== "object" || value === null) throw new Error("Runtime event must be an object");
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || !event.id) throw new Error("Runtime event id is required");
  if (typeof event.agentId !== "string" || !event.agentId) throw new Error("Runtime event agentId is required");
  if (typeof event.type !== "string" || !eventTypes.has(event.type as RuntimeEventType)) throw new Error("Unknown runtime event type");
  if (typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt))) throw new Error("Runtime event createdAt is invalid");
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) throw new Error("Runtime event payload must be an object");
  return event as CanonicalRuntimeEvent;
}

export function stableProgressEventId(agentId: string, itemId: string, stream: "activity" | "usage" = "activity") {
  return `${stream}:${agentId}:${itemId}`;
}
