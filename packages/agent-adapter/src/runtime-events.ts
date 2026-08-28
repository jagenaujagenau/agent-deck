import { isJsonNumber, isJsonObject, isJsonString } from "./json-value";
import type { JsonObject, JsonValue } from "./json-value";

export type RuntimeEventType =
  | "session.registered"
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
export type RuntimeRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "answered"
  | "expired"
  | "unavailable";

/**
 * Which publisher said it, and where in that publisher's own order.
 *
 * Two processes can report the same session — a hook invocation and its
 * long-lived daemon — and either can publish a state it read before the other
 * advanced it. A report that names its source and a monotonic sequence lets
 * the ingester drop the stale one instead of letting the slower publisher win.
 */
export type RuntimeEventOrigin = { source: string; seq: number };

export type CanonicalRuntimeEvent = {
  id: string;
  agentId: string;
  type: RuntimeEventType;
  createdAt: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  origin?: RuntimeEventOrigin;
  payload: JsonObject;
};

// Held as strings so unparsed wire values can be probed without asserting first.
const eventTypes: ReadonlySet<string> = new Set<RuntimeEventType>([
  "session.registered",
  "session.state.changed",
  "turn.started",
  "turn.completed",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "item.started",
  "item.updated",
  "item.completed",
  "token-usage.updated",
  "rate-limits.updated",
  "runtime.error",
]);

export function canonicalRuntimeEvent<Input>(value: Input): CanonicalRuntimeEvent {
  if (Object(value) !== value || value instanceof Function)
    throw new Error("Runtime event must be an object");
  // SAFETY: runtime events reach this boundary as decoded JSON — request
  // bodies and re-read database rows — so a non-function object here is a
  // JSON object; every field the contract names is checked below.
  const event = value as { [key: string]: JsonValue | undefined };
  if (!isJsonString(event.id) || !event.id) throw new Error("Runtime event id is required");
  if (!isJsonString(event.agentId) || !event.agentId)
    throw new Error("Runtime event agentId is required");
  if (!isJsonString(event.type) || !eventTypes.has(event.type))
    throw new Error("Unknown runtime event type");
  if (!isJsonString(event.createdAt) || Number.isNaN(Date.parse(event.createdAt)))
    throw new Error("Runtime event createdAt is invalid");
  if (!isJsonObject(event.payload)) throw new Error("Runtime event payload must be an object");
  // Origin is advisory: a report that names its publisher and position can be
  // ordered against its siblings, and one that names them badly cannot. So a
  // malformed origin is treated as absent rather than rejecting the event —
  // the fact it carries is still true, it just cannot be ordered.
  if (event.origin !== undefined) {
    const origin = event.origin;
    if (
      !isJsonObject(origin) ||
      !isJsonString(origin.source) ||
      !origin.source ||
      !isJsonNumber(origin.seq)
    ) {
      delete event.origin;
    }
  }
  // SAFETY: every named field was just checked. turnId/itemId/requestId remain
  // the optional wire strings their producers write, and unknown extra fields
  // ride along untouched, as they always have.
  return event as CanonicalRuntimeEvent;
}

export function stableProgressEventId(
  agentId: string,
  itemId: string,
  stream: "activity" | "usage" = "activity",
) {
  return `${stream}:${agentId}:${itemId}`;
}
