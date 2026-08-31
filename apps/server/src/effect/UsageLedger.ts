import { Effect, Ref } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { scanClaudeUsage, scanCodexUsage, type TranscriptUsageRow } from "../transcriptUsage";
import type { ActivityRow, UsageRow } from "./Analytics";
import type { AgentEvent } from "./Domain";
import type { AgentRecord } from "./State";

/**
 * The one owner of what the deck has spent (`bridge_usage_deltas`,
 * `bridge_usage_cursors`) and what it has done (`bridge_activity`).
 *
 * ADR-0001 keeps Processed Usage and Context Usage apart: the first is
 * monotonic history, the second is pressure on a live context, and the
 * analytics must never infer one from the other. That rule used to be
 * enforced by *adjacency* — twenty lines of high-water cursor arithmetic
 * sitting in the middle of a ninety-line `heartbeat` whose actual job is
 * identity and liveness. Nothing named the invariant, and nothing could
 * test it without sending a heartbeat.
 *
 * The cursor is why a runtime may re-report the same totals forever without
 * the deck counting them twice: what is stored is the *rise* over the
 * high-water mark, and the mark only ever moves up.
 */

/** A usage figure as a runtime reported it, or the fallback when it reported nonsense. */
export const usageNumber = (value: number | null | undefined, fallback: number): number =>
  value != null && Number.isFinite(value) ? value : fallback;

/**
 * Which harness a session's spending is attributed to.
 *
 * The runtime's own word for itself when it sent one; the name prefix is the
 * fallback for snapshots from an adapter that predates the field.
 */
export const runtimeFor = (agent: Pick<AgentRecord, "name" | "runtime">): string => {
  if (agent.runtime) return agent.runtime;
  if (agent.name.startsWith("Claude")) return "claude";
  if (agent.name.startsWith("Codex")) return "codex";
  if (agent.name.startsWith("Pi")) return "pi";
  return "other";
};

/**
 * What one heartbeat added to the ledger, given what the cursor already
 * held. Split out so the double-counting rule can be read — and tested —
 * without a database: a re-report adds nothing, a rise adds the rise, and a
 * figure that went backwards (a runtime restarting its own accounting)
 * adds nothing rather than a negative.
 */
export type UsageFigures = { tokens: number; costUsd: number };

export const usageRise = (
  reported: UsageFigures,
  cursor: UsageFigures | undefined,
): UsageFigures => ({
  tokens: Math.max(0, reported.tokens - (cursor?.tokens ?? 0)),
  costUsd: Math.max(0, reported.costUsd - (cursor?.costUsd ?? 0)),
});

/** How long a transcript scan is reused before the files are read again. */
const TRANSCRIPT_CACHE_MS = 5 * 60_000;

export type TranscriptScan = {
  cutoff: string;
  expiresAt: number;
  rows: ReadonlyArray<TranscriptUsageRow>;
  claudeFiles: number;
  codexFiles: number;
  duplicates: number;
};

/** An empty transcript cache, so a caller needs no assertion to make one. */
export const emptyTranscriptCache = () => Ref.make<TranscriptScan | undefined>(undefined);

export interface UsageLedgerDeps {
  readonly sql: SqlClient.SqlClient;
  readonly now: () => string;
}

export const makeUsageLedger = (
  deps: UsageLedgerDeps,
  transcriptCacheRef: Ref.Ref<TranscriptScan | undefined>,
) => {
  const { sql, now } = deps;

  /**
   * Records what this heartbeat spent, as the rise over the high-water mark.
   *
   * The mark moves with `MAX` rather than assignment, so a runtime that
   * under-reports after a restart cannot rewind the deck's history of what
   * it already spent.
   */
  const record = Effect.fn("UsageLedger.record")(function* (agent: AgentRecord) {
    const processedTokens = usageNumber(agent.processedTokens, agent.tokens);
    const rows = yield* sql<{ tokens: number; cost_usd: number }>`
      SELECT tokens, cost_usd FROM bridge_usage_cursors WHERE agent_id = ${agent.id}`;
    const cursor = rows[0];
    const rise = usageRise(
      { tokens: processedTokens, costUsd: agent.costUsd },
      cursor && { tokens: cursor.tokens, costUsd: cursor.cost_usd },
    );
    if (rise.tokens > 0 || rise.costUsd > 0) {
      yield* sql`INSERT INTO bridge_usage_deltas (agent_id, project, runtime, tokens, cost_usd, created_at)
                 VALUES (${agent.id}, ${agent.project}, ${runtimeFor(agent)}, ${rise.tokens}, ${rise.costUsd}, ${now()})`;
    }
    yield* sql`INSERT INTO bridge_usage_cursors (agent_id, tokens, cost_usd, updated_at)
               VALUES (${agent.id}, ${processedTokens}, ${agent.costUsd}, ${now()})
               ON CONFLICT(agent_id) DO UPDATE SET tokens = MAX(tokens, excluded.tokens),
                 cost_usd = MAX(cost_usd, excluded.cost_usd), updated_at = excluded.updated_at`;
  }, Effect.orDie);

  /** One thing a session did, counted for the activity heatmap. */
  const recordActivity = Effect.fn("UsageLedger.recordActivity")(function* (
    agent: AgentRecord,
    event: AgentEvent,
  ) {
    yield* sql`INSERT OR IGNORE INTO bridge_activity (id, agent_id, project, runtime, kind, created_at)
               VALUES (${event.id}, ${agent.id}, ${agent.project}, ${runtimeFor(agent)}, ${event.kind}, ${event.createdAt})`;
  }, Effect.orDie);

  /** Everything the deck has spent, ever — the snapshot's running total. */
  const total = Effect.fn("UsageLedger.total")(function* () {
    const rows = yield* sql<{ tokens: number; cost_usd: number }>`
      SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM bridge_usage_deltas`;
    return rows[0] ?? { tokens: 0, cost_usd: 0 };
  }, Effect.orDie);

  const since = Effect.fn("UsageLedger.since")(function* (cutoff: string) {
    const usage = yield* sql<UsageRow>`
      SELECT agent_id, project, runtime, tokens, cost_usd, created_at
      FROM bridge_usage_deltas WHERE created_at >= ${cutoff} ORDER BY created_at`;
    const activity = yield* sql<ActivityRow>`
      SELECT agent_id, project, runtime, kind, created_at
      FROM bridge_activity WHERE created_at >= ${cutoff} ORDER BY created_at`;
    return { usage, activity };
  }, Effect.orDie);

  /**
   * Scanning every transcript is expensive, so a scan is reused for five
   * minutes. A cached scan reaching further back than the current cutoff is
   * still usable — it is filtered down rather than redone.
   */
  const transcripts = Effect.fn("UsageLedger.transcripts")(function* (cutoff: string) {
    const cached = yield* Ref.get(transcriptCacheRef);
    if (cached && cached.expiresAt > Date.now() && cached.cutoff <= cutoff) {
      return { ...cached, rows: cached.rows.filter((row) => row.created_at >= cutoff) };
    }
    const [claude, codex] = yield* Effect.all(
      [Effect.promise(() => scanClaudeUsage(cutoff)), Effect.promise(() => scanCodexUsage(cutoff))],
      { concurrency: 2 },
    );
    const fresh: TranscriptScan = {
      cutoff,
      expiresAt: Date.now() + TRANSCRIPT_CACHE_MS,
      rows: [...claude.rows, ...codex.rows],
      claudeFiles: claude.files,
      codexFiles: codex.files,
      duplicates: claude.duplicates,
    };
    yield* Ref.set(transcriptCacheRef, fresh);
    return fresh;
  });

  return { record, recordActivity, total, since, transcripts };
};
