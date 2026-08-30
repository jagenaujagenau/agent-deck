import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  emptyRuntimeProjection,
  projectRuntimeEvent,
  type CanonicalRuntimeEvent,
  type RuntimeProjection,
} from "@agent-control-dashboard/agent-adapter";

/**
 * The durable ordered log of Runtime Events, and the projection folded from it.
 *
 * ADR-0001's core invariant lives here and nowhere else: every accepted event
 * lands in the log exactly once (replays collapse on id), takes the log's own
 * sequence, and is folded into the agent's Runtime Projection — which is only
 * ever advanced, never regressed, by the sequence guard on the persist. The
 * projection column is written by this module alone, so reading it back is
 * reading our own serialisation, not a foreign payload.
 */

/**
 * Whether a state report arrived behind one already accepted from the same
 * publisher, recording the newer position when it did not.
 *
 * Only "session.state.changed" is guarded: item, tool, and usage facts are
 * append-only history, where arriving late loses nothing. A report with no
 * origin keeps the old behaviour exactly — every in-tree adapter now names
 * one through the shared publisher, but events from an older adapter or a
 * third-party integration must keep landing.
 */
export const isStaleStateReport = (
  lastAcceptedSeq: Map<string, number>,
  event: Pick<CanonicalRuntimeEvent, "type" | "agentId" | "origin">,
): boolean => {
  if (event.type !== "session.state.changed" || event.origin === undefined) return false;
  const key = `${event.agentId}\u0000${event.origin.source}`;
  const last = lastAcceptedSeq.get(key);
  if (last !== undefined && event.origin.seq <= last) return true;
  lastAcceptedSeq.set(key, event.origin.seq);
  return false;
};

export interface RuntimeEventLogDeps {
  sql: SqlClient.SqlClient;
  now: () => string;
}

export function makeRuntimeEventLog(deps: RuntimeEventLogDeps) {
  const { sql, now } = deps;
  /** The newest accepted report position per (agent, source) — the stale guard's memory. */
  const stateReportSeqs = new Map<string, number>();

  const readProjection = (raw: string): RuntimeProjection | undefined => {
    try {
      // SAFETY: the projection column is written only by `append` below, which
      // serialises exactly a RuntimeProjection; a corrupt row reads as absent
      // and is rebuilt from the next event.
      return JSON.parse(raw) as RuntimeProjection;
    } catch {
      return undefined;
    }
  };

  /**
   * Appends one event and folds it forward, returning the log's sequence.
   * A replayed id collapses onto its first landing and returns that sequence.
   */
  const append = Effect.fn("RuntimeEventLog.append")(function* (event: CanonicalRuntimeEvent) {
    yield* sql`INSERT OR IGNORE INTO bridge_runtime_events (id, agent_id, type, data, created_at)
               VALUES (${event.id}, ${event.agentId}, ${event.type}, ${JSON.stringify(event)}, ${event.createdAt})`;
    const seqRows = yield* sql<{ sequence: number }>`
      SELECT sequence FROM bridge_runtime_events WHERE id = ${event.id}`;
    const sequence = seqRows[0]?.sequence ?? 0;
    if (sequence > 0) {
      const projRows = yield* sql<{ data: string }>`
        SELECT data FROM bridge_runtime_projections WHERE agent_id = ${event.agentId}`;
      const projection =
        (projRows[0] && readProjection(projRows[0].data)) ?? emptyRuntimeProjection(event.agentId);
      const projected = projectRuntimeEvent(projection, event, sequence);
      yield* sql`INSERT INTO bridge_runtime_projections (agent_id, sequence, data, updated_at)
                 VALUES (${event.agentId}, ${projected.sequence}, ${JSON.stringify(projected)}, ${projected.updatedAt})
                 ON CONFLICT(agent_id) DO UPDATE SET sequence = excluded.sequence, data = excluded.data,
                   updated_at = excluded.updated_at
                 WHERE excluded.sequence >= bridge_runtime_projections.sequence`;
    }
    return sequence;
  }, Effect.orDie);

  /** Appends a fact the bridge itself asserts, owning the envelope. */
  const record = (
    agentId: string,
    type: CanonicalRuntimeEvent["type"],
    payload: CanonicalRuntimeEvent["payload"],
    refs: { id?: string; requestId?: string; itemId?: string } = {},
  ) => {
    const event: CanonicalRuntimeEvent = {
      id: refs.id ?? crypto.randomUUID(),
      agentId,
      type,
      createdAt: now(),
      payload,
    };
    // Only the lifecycles that have them carry these, and the projector
    // reading these back treats a present-but-undefined key differently
    // from an absent one.
    if (refs.requestId !== undefined) event.requestId = refs.requestId;
    if (refs.itemId !== undefined) event.itemId = refs.itemId;
    return append(event);
  };

  /**
   * Accepts a runtime's report into the log, unless it lost the race with a
   * newer one from the same publisher. Dropped as a success, not an error: a
   * well-behaved runtime retries an error, and retrying a report that lost
   * the race would never converge.
   */
  const ingest = Effect.fn("RuntimeEventLog.ingest")(function* (event: CanonicalRuntimeEvent) {
    if (isStaleStateReport(stateReportSeqs, event)) {
      return { accepted: false, reason: "stale" } as const;
    }
    const sequence = yield* append(event);
    return { sequence } as const;
  });

  /** One agent's stored projection, with the sequence it stands at. */
  const projection = Effect.fn("RuntimeEventLog.projection")(function* (agentId: string) {
    const rows = yield* sql<{ sequence: number; data: string }>`
      SELECT sequence, data FROM bridge_runtime_projections WHERE agent_id = ${agentId}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return { sequence: row.sequence, projection: readProjection(row.data) };
  }, Effect.orDie);

  /** Every stored projection in one query — the snapshot's read. */
  const projections = Effect.fn("RuntimeEventLog.projections")(function* () {
    const rows = yield* sql<{ agent_id: string; data: string }>`
      SELECT agent_id, data FROM bridge_runtime_projections`;
    const out = new Map<string, RuntimeProjection>();
    for (const row of rows) {
      const stored = readProjection(row.data);
      if (stored) out.set(row.agent_id, stored);
    }
    return out;
  }, Effect.orDie);

  return { append, record, ingest, projection, projections };
}
