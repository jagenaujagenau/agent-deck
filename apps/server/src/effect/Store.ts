import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AgentEvent } from "./Domain";

/**
 * Reading a persisted row is a boundary: the JSON blob in `bridge_agents` was
 * written by an older build, and a field that has since changed shape should
 * surface here rather than as a confusing failure three layers up.
 */
export class StoredAgentError extends Schema.TaggedError<StoredAgentError>()("StoredAgentError", {
  agentId: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Snapshot events are trimmed to what a card renders; see SNAPSHOT_* below. */
const SNAPSHOT_EVENT_LIMIT = 24;
const SNAPSHOT_DETAIL_LIMIT = 400;
// A command cut mid-line is unreadable, which is the whole point of the terminal view. Measured
// over a full window: at 600 this cut 42% of commands, at 3000 it cuts 3%, for ~220KB more on a
// fetch that is throttled and per-session. The cap stays only to bound a pathological heredoc.
const HISTORY_COMMAND_LIMIT = 3000;

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

/**
 * A snapshot feeds live cards and is re-sent on every change, so it carries
 * only what a card can show: whole histories and diff bodies are served per
 * session instead.
 */
const cardEvent = (event: AgentEvent): AgentEvent => {
  const { diff: _diff, command: _command, ...rest } = event;
  return {
    ...rest,
    // A runtime may send detail as null rather than omitting it; both mean absent.
    detail: rest.detail == null ? undefined : clip(rest.detail, SNAPSHOT_DETAIL_LIMIT),
  };
};

const parseOptions = (value: string | null): ReadonlyArray<string> | undefined => {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as ReadonlyArray<string>;
  } catch {
    return undefined;
  }
};

export class BridgeStore extends Context.Service<
  BridgeStore,
  {
    /** Every agent the bridge knows, as the snapshot renders them. */
    readonly agents: Effect.Effect<ReadonlyArray<Record<string, unknown>>, StoredAgentError>;
    /** A session's retained history: whole conversation plus recent activity. */
    /**
     * A session's retained history. `limit` trims it to the most recent
     * exchanges for a caller that cannot use the whole thing - a watch reading
     * over wifi, where the full history is most of a megabyte.
     */
    readonly history: (agentId: string, limit?: number) => Effect.Effect<ReadonlyArray<AgentEvent>>;
    /** Every file change a session produced, oldest first. */
    readonly fileChanges: (agentId: string) => Effect.Effect<ReadonlyArray<AgentEvent>>;
    /** What a session can be asked to run by name. */
    readonly slashCommands: (agentId: string) => Effect.Effect<ReadonlyArray<unknown>>;
    /** Historical token and cost totals shown in the snapshot summary. */
    readonly usageTotals: Effect.Effect<{ tokens: number; costUsd: number }>;
  }
>()("agent-deck/server/BridgeStore") {
  static readonly layer = Layer.effect(
    BridgeStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const agents = Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          data: string;
        }>`SELECT id, data FROM bridge_agents`.pipe(Effect.orDie);
        const decoded: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const agent = yield* Effect.try({
            try: () => JSON.parse(row.data) as Record<string, unknown>,
            catch: (cause) => new StoredAgentError({ agentId: row.id, cause }),
          });
          const events = Array.isArray(agent.events) ? (agent.events as Array<AgentEvent>) : [];
          decoded.push({
            ...agent,
            events: events.slice(-SNAPSHOT_EVENT_LIMIT).reverse().map(cardEvent),
          });
        }
        return decoded;
      });

      const rowsToEvents = (
        rows: ReadonlyArray<{
          id: string;
          kind: string;
          summary: string;
          detail: string | null;
          tool: string | null;
          command: string | null;
          path: string | null;
          options: string | null;
          created_at: string;
        }>,
      ): ReadonlyArray<AgentEvent> =>
        // Rows arrive newest-first from the LIMIT; flip to oldest-first so the
        // stable sort in `history` breaks equal-timestamp ties in real order.
        [...rows].reverse().map((row) => ({
          id: row.id,
          kind: row.kind as AgentEvent["kind"],
          summary: row.summary,
          // A tool event's detail is the rendered tool call, which no tab shows.
          detail: row.tool ? undefined : (row.detail ?? undefined),
          tool: row.tool ?? undefined,
          command: row.command === null ? undefined : clip(row.command, HISTORY_COMMAND_LIMIT),
          path: row.path ?? undefined,
          options: parseOptions(row.options),
          createdAt: row.created_at,
        }));

      const history = Effect.fn("BridgeStore.history")(function* (agentId: string, limit?: number) {
        // Conversation is fetched separately from recent activity: tool events
        // outnumber messages by an order of magnitude, so a flat "most recent
        // N" would keep the chatter and drop the conversation.
        const conversation = yield* sql<any>`
          SELECT id, kind, summary, detail, tool, command, path, options, created_at
          FROM bridge_session_events
          WHERE agent_id = ${agentId}
            AND (kind = 'user' OR summary LIKE 'Remote command:%'
                 OR (kind = 'thought' AND summary = 'Received instruction')
                 OR (kind = 'output' AND tool IS NULL AND command IS NULL))
          ORDER BY created_at DESC LIMIT 500`;
        const recent = yield* sql<any>`
          SELECT id, kind, summary, detail, tool, command, path, options, created_at
          FROM bridge_session_events
          WHERE agent_id = ${agentId}
          ORDER BY created_at DESC LIMIT 600`;
        const byId = new Map<string, AgentEvent>();
        for (const event of rowsToEvents(conversation)) byId.set(event.id, event);
        for (const event of rowsToEvents(recent)) byId.set(event.id, event);
        const ordered = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        // Trimming takes the newest, because a conversation is read from its end.
        return limit !== undefined && limit > 0 && ordered.length > limit
          ? ordered.slice(-limit)
          : ordered;
      }, Effect.orDie);

      const fileChanges = Effect.fn("BridgeStore.fileChanges")(function* (agentId: string) {
        const rows = yield* sql<{
          id: string;
          path: string | null;
          tool: string | null;
          diff: string;
          created_at: string;
        }>`SELECT id, path, tool, diff, created_at FROM bridge_file_changes
           WHERE agent_id = ${agentId} ORDER BY created_at`;
        return rows.map((row): AgentEvent => ({
          id: row.id,
          kind: "output",
          summary: row.tool ? `${row.tool} completed` : "File change",
          path: row.path ?? undefined,
          tool: row.tool ?? undefined,
          diff: row.diff,
          createdAt: row.created_at,
        }));
      }, Effect.orDie);

      const slashCommands = Effect.fn("BridgeStore.slashCommands")(function* (agentId: string) {
        const rows = yield* sql<{ commands: string }>`
          SELECT commands FROM bridge_slash_commands WHERE agent_id = ${agentId}`;
        const row = rows[0];
        if (row === undefined) return [];
        return yield* Effect.try({
          try: () => JSON.parse(row.commands) as ReadonlyArray<unknown>,
          catch: () => [] as ReadonlyArray<unknown>,
        }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<unknown>));
      }, Effect.orDie);

      const usageTotals = Effect.gen(function* () {
        const rows = yield* sql<{ tokens: number; cost_usd: number }>`
          SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
          FROM bridge_usage_deltas`;
        const row = rows[0];
        return { tokens: row?.tokens ?? 0, costUsd: row?.cost_usd ?? 0 };
      }).pipe(Effect.orDie);

      return BridgeStore.of({ agents, history, fileChanges, slashCommands, usageTotals });
    }),
  );
}
