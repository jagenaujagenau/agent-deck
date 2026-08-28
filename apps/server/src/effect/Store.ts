import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AgentEvent, JsonValue } from "./Domain";

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

/**
 * Trims a fetched history to `limit`, keeping both streams alive.
 *
 * Fetching conversation and recent activity separately is pointless if the two
 * are then trimmed together: tool events outnumber messages by two hundred to
 * one, so a flat newest-N evicts every word said more than an hour ago. The
 * first fix gave conversation absolute priority — and a session whose chat
 * alone exceeded the limit then returned a terminal with no commands and a
 * Changes tab with no files. So the conversation keeps priority, but never the
 * whole budget: a third is reserved for activity, and either side's unused
 * share spills to the other.
 */
export const trimHistory = (
  ordered: ReadonlyArray<AgentEvent>,
  spoken: ReadonlySet<string>,
  limit?: number,
): ReadonlyArray<AgentEvent> => {
  if (limit === undefined || limit <= 0 || ordered.length <= limit) return ordered;
  const words = ordered.filter((event) => spoken.has(event.id));
  const chatter = ordered.filter((event) => !spoken.has(event.id));
  const activityShare = Math.min(chatter.length, Math.floor(limit / 3));
  const keptWords = words.slice(-(limit - activityShare));
  const keptChatter = chatter.slice(-(limit - keptWords.length));
  const kept = new Set([...keptWords, ...keptChatter].map((event) => event.id));
  return ordered.filter((event) => kept.has(event.id));
};

const parseOptions = (value: string | null): ReadonlyArray<string> | undefined => {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * A stored agent blob as `agents` serves it: whichever fields the build that
 * wrote the row put there, with the live window replaced by trimmed card
 * events. The open shape is deliberate - the snapshot passes a stored agent
 * through rather than deciding which of an older build's fields to drop.
 */
export interface StoredAgentSnapshot {
  [key: string]: JsonValue | ReadonlyArray<AgentEvent> | undefined;
}

export class BridgeStore extends Context.Service<
  BridgeStore,
  {
    /** Every agent the bridge knows, as the snapshot renders them. */
    readonly agents: Effect.Effect<ReadonlyArray<StoredAgentSnapshot>, StoredAgentError>;
    /** A session's retained history: whole conversation plus recent activity. */
    /**
     * A session's retained history. `limit` trims it to the most recent
     * exchanges for a caller that cannot use the whole thing - a watch reading
     * over wifi, where the full history is most of a megabyte.
     */
    readonly history: (
      agentId: string,
      limit?: number,
      before?: string,
    ) => Effect.Effect<ReadonlyArray<AgentEvent>>;
    /** Every file change a session produced, oldest first. */
    readonly fileChanges: (agentId: string) => Effect.Effect<ReadonlyArray<AgentEvent>>;
    /** What a session can be asked to run by name. */
    readonly slashCommands: (agentId: string) => Effect.Effect<ReadonlyArray<JsonValue>>;
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
        const decoded: Array<StoredAgentSnapshot> = [];
        for (const row of rows) {
          const agent = yield* Effect.try({
            try: (): StoredAgentSnapshot => JSON.parse(row.data),
            catch: (cause) => new StoredAgentError({ agentId: row.id, cause }),
          });
          // SAFETY: the row was written by persistAgent from an AgentRecord, so
          // an `events` value that is an array holds AgentEvent documents.
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
          subagent_id: string | null;
          subagent_type: string | null;
          subagent_name: string | null;
          turn_id: string | null;
          created_at: string;
        }>,
      ): ReadonlyArray<AgentEvent> =>
        // Rows arrive newest-first from the LIMIT; flip to oldest-first so the
        // stable sort in `history` breaks equal-timestamp ties in real order.
        [...rows].reverse().map((row) => ({
          id: row.id,
          // SAFETY: the kind column is only ever written from a validated
          // AgentEvent, so a stored value is one of the event kinds.
          kind: row.kind as AgentEvent["kind"],
          summary: row.summary,
          // A tool event's detail is the rendered tool call, which no tab
          // shows - except a subagent's completion, whose detail is the only
          // thing that subagent ever says. Dropping it with the rest meant a
          // session read through a subagent showed its tool calls and none of
          // its words.
          detail:
            row.tool && !(row.tool === "Task" && row.subagent_id)
              ? undefined
              : (row.detail ?? undefined),
          tool: row.tool ?? undefined,
          command: row.command === null ? undefined : clip(row.command, HISTORY_COMMAND_LIMIT),
          path: row.path ?? undefined,
          options: parseOptions(row.options),
          subagentId: row.subagent_id ?? undefined,
          subagentType: row.subagent_type ?? undefined,
          subagentName: row.subagent_name ?? undefined,
          turnId: row.turn_id ?? undefined,
          createdAt: row.created_at,
        }));

      const history = Effect.fn("BridgeStore.history")(function* (
        agentId: string,
        limit?: number,
        before?: string,
      ) {
        // Paging: `before` reopens the log earlier than the given instant, so
        // a client can walk a long session back one window at a time.
        const cutoff = before ?? "\uffff";
        // Conversation is fetched separately from recent activity: tool events
        // outnumber messages by an order of magnitude, so a flat "most recent
        // N" would keep the chatter and drop the conversation.
        const conversation = yield* sql<any>`
          SELECT id, kind, summary, detail, tool, command, path, options, subagent_id, subagent_type, subagent_name, turn_id, created_at
          FROM bridge_session_events
          WHERE agent_id = ${agentId} AND created_at < ${cutoff}
            AND (kind = 'user' OR summary LIKE 'Remote command:%'
                 OR (kind = 'thought' AND summary = 'Received instruction')
                 -- A subagent's parting message is conversation, not chatter.
                 -- Left in the recency bucket it was evicted by the subagent's
                 -- own tool calls, which outnumber it by two hundred to one.
                 OR (tool = 'Task' AND subagent_id IS NOT NULL)
                 OR (kind = 'output' AND tool IS NULL AND command IS NULL))
          ORDER BY created_at DESC LIMIT 500`;
        const recent = yield* sql<any>`
          SELECT id, kind, summary, detail, tool, command, path, options, subagent_id, subagent_type, subagent_name, turn_id, created_at
          FROM bridge_session_events
          WHERE agent_id = ${agentId} AND created_at < ${cutoff}
          ORDER BY created_at DESC LIMIT 600`;
        const byId = new Map<string, AgentEvent>();
        const spoken = new Set<string>();
        for (const event of rowsToEvents(conversation)) {
          byId.set(event.id, event);
          spoken.add(event.id);
        }
        for (const event of rowsToEvents(recent)) byId.set(event.id, event);
        const ordered = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return trimHistory(ordered, spoken, limit);
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
          try: (): ReadonlyArray<JsonValue> => JSON.parse(row.commands),
          catch: (): ReadonlyArray<JsonValue> => [],
        }).pipe(Effect.orElseSucceed((): ReadonlyArray<JsonValue> => []));
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
