import type { JsonObject, JsonValue } from "./json-value";
import type { CanonicalRuntimeEvent, RuntimeEventType } from "./runtime-events";

/**
 * The one way an adapter publishes a canonical Runtime Event.
 *
 * Every adapter used to assemble the envelope itself, and three of five forgot
 * `origin` — which is exactly the field the bridge's stale-report guard keys
 * on, so the publishers most likely to race were the ones outside its
 * protection. Here the envelope is owned by the publisher: id, timestamp, and
 * origin are stamped in one place, and forgetting them is unrepresentable.
 */

type RuntimeEventRefs = {
  /** A stable id when the event must dedupe at the bridge; generated otherwise. */
  id?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  /**
   * This report's position in the publisher's own order, for adapters whose
   * order lives outside this process — the hooks share a persisted per-session
   * counter across a daemon and fallback hook processes. Left out, the
   * publisher numbers the report itself.
   */
  seq?: number;
};

/** Absent facts are omitted rather than sent; the wire only speaks JSON. */
export type RuntimeEventPayload = Record<string, JsonValue | undefined>;

export type RuntimePublisher = (
  agentId: string,
  type: RuntimeEventType,
  payload: RuntimeEventPayload,
  refs?: RuntimeEventRefs,
) => Promise<void>;

/**
 * Builds a publisher bound to one origin source.
 *
 * The default sequence is per agent, seeded from the clock so a restarted
 * publisher keeps ascending — the bridge orders reports per (agent, source),
 * and a counter that restarted at one would read as a flood of stale reports.
 * Send failures propagate to the caller, which owns the retry-or-drop choice;
 * the sequence still advances, so a report that died on the wire can never
 * lend its number to a different fact.
 */
export function createRuntimePublisher(options: {
  /** Named on every event; the bridge keys its per-source order on it. */
  source: string;
  send: (event: CanonicalRuntimeEvent) => Promise<void>;
}): RuntimePublisher {
  const lastSeq = new Map<string, number>();
  const nextSeq = (agentId: string) => {
    const seq = Math.max(Date.now(), (lastSeq.get(agentId) ?? 0) + 1);
    lastSeq.set(agentId, seq);
    return seq;
  };
  return async (agentId, type, payload, refs = {}) => {
    const facts: JsonObject = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) facts[key] = value;
    }
    const event: CanonicalRuntimeEvent = {
      id: refs.id ?? crypto.randomUUID(),
      agentId,
      type,
      createdAt: new Date().toISOString(),
      origin: { source: options.source, seq: refs.seq ?? nextSeq(agentId) },
      payload: facts,
    };
    if (refs.turnId) event.turnId = refs.turnId;
    if (refs.itemId) event.itemId = refs.itemId;
    if (refs.requestId) event.requestId = refs.requestId;
    await options.send(event);
  };
}
