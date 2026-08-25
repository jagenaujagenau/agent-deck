import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  canonicalRuntimeEvent,
  emptyRuntimeProjection,
  projectRuntimeEvent,
} from "@agent-control-dashboard/agent-adapter";
import type { RuntimeProjection } from "@agent-control-dashboard/agent-adapter";

/**
 * Everything that has to be true of the database before the bridge serves a
 * request.
 *
 * This runs on every start rather than once. Each statement is idempotent, and
 * a bridge handed an empty file has to be able to build itself - the deployed
 * bridge did this from its constructor, so a database has never needed a
 * separate migration step to exist. Keeping it in a layer is what stops the
 * server accepting traffic before it has finished.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bridge_agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_commands (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT, scopes TEXT NOT NULL DEFAULT 'read,control')`,
  `CREATE TABLE IF NOT EXISTS bridge_pairing_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS bridge_usage_deltas (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, project TEXT NOT NULL, runtime TEXT NOT NULL, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bridge_usage_created_idx ON bridge_usage_deltas(created_at)`,
  `CREATE TABLE IF NOT EXISTS bridge_usage_cursors (agent_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_activity (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project TEXT NOT NULL, runtime TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_file_changes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, path TEXT, tool TEXT, diff TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_slash_commands (agent_id TEXT PRIMARY KEY, commands TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_session_events (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, tool TEXT, command TEXT, path TEXT, options TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bridge_session_events_agent_idx ON bridge_session_events(agent_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS bridge_file_changes_agent_idx ON bridge_file_changes(agent_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS bridge_activity_created_idx ON bridge_activity(created_at)`,
  `CREATE TABLE IF NOT EXISTS bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_runtime_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS bridge_runtime_events_agent_sequence_idx ON bridge_runtime_events(agent_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS bridge_runtime_projections (agent_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bridge_requests (request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, resolved_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS bridge_requests_agent_status_idx ON bridge_requests(agent_id, status)`,
  `CREATE TABLE IF NOT EXISTS bridge_command_receipts (command_id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT, result_sequence INTEGER, updated_at TEXT NOT NULL)`,
] as const;

const now = () => new Date().toISOString();

/**
 * Brings a database up to date and reconciles what a restart invalidated.
 *
 * Provided ahead of the services that read it, so ordering is a fact of the
 * layer graph rather than something a caller has to remember.
 */
export const BridgeSchema = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // WAL lets the hooks write while a phone is reading; the timeout stops a
    // concurrent writer failing outright rather than waiting its turn.
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`PRAGMA busy_timeout = 5000`;

    for (const statement of SCHEMA) {
      yield* sql.unsafe(statement);
    }

    // `scopes` was added after bridge_devices shipped, so a database created
    // before that has the table but not the column.
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(bridge_devices)`;
    if (!columns.some((column) => column.name === "scopes")) {
      yield* sql.unsafe(
        "ALTER TABLE bridge_devices ADD COLUMN scopes TEXT NOT NULL DEFAULT 'read,control'",
      );
    }

    // Tool hooks may run from nested directories, so a fact can arrive tagged
    // with a transient cwd. History belongs to the session's stable project.
    yield* sql`UPDATE bridge_activity SET project = (SELECT json_extract(data, '$.project') FROM bridge_agents WHERE bridge_agents.id = bridge_activity.agent_id) WHERE EXISTS (SELECT 1 FROM bridge_agents WHERE bridge_agents.id = bridge_activity.agent_id AND json_extract(data, '$.project') IS NOT NULL AND json_extract(data, '$.project') != '')`;
    yield* sql`UPDATE bridge_usage_deltas SET project = (SELECT json_extract(data, '$.project') FROM bridge_agents WHERE bridge_agents.id = bridge_usage_deltas.agent_id) WHERE EXISTS (SELECT 1 FROM bridge_agents WHERE bridge_agents.id = bridge_usage_deltas.agent_id AND json_extract(data, '$.project') IS NOT NULL AND json_extract(data, '$.project') != '')`;

    // A database that predates projections has the events but not the view of
    // them, so it is replayed once.
    const projected = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM bridge_runtime_projections`;
    if ((projected[0]?.count ?? 0) === 0) {
      const events = yield* sql<{ data: string }>`
        SELECT data FROM bridge_runtime_events ORDER BY sequence`;
      const rebuilt = new Map<string, RuntimeProjection>();
      let sequence = 0;
      for (const row of events) {
        sequence += 1;
        try {
          const event = canonicalRuntimeEvent(JSON.parse(row.data));
          const previous = rebuilt.get(event.agentId) ?? emptyRuntimeProjection(event.agentId);
          rebuilt.set(event.agentId, projectRuntimeEvent(previous, event, sequence));
        } catch {
          // A row written by an older, incompatible build is skipped rather
          // than stopping the rebuild for every other session.
        }
      }
      for (const projection of rebuilt.values()) {
        yield* sql`INSERT INTO bridge_runtime_projections (agent_id, sequence, data, updated_at)
                   VALUES (${projection.agentId}, ${projection.sequence}, ${JSON.stringify(projection)}, ${projection.updatedAt})
                   ON CONFLICT(agent_id) DO UPDATE SET sequence = excluded.sequence,
                     data = excluded.data, updated_at = excluded.updated_at`;
      }
    }

    // A bridge-hosted session does not survive a restart: its process is gone,
    // so anything still marked pending against it will never be answered.
    const managed = yield* sql<{ id: string; data: string }>`
      SELECT id, data FROM bridge_agents WHERE id LIKE 'managed-%'`;
    for (const row of managed) {
      let agent: Record<string, unknown>;
      try {
        agent = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (agent.state === "offline") continue;
      agent.state = "offline";
      agent.task = "Managed host restarted";
      yield* sql`UPDATE bridge_agents SET data = ${JSON.stringify(agent)}, updated_at = ${now()}
                 WHERE id = ${row.id}`;
      yield* sql`UPDATE bridge_requests SET status = 'unavailable', resolved_at = ${now()}
                 WHERE agent_id = ${row.id} AND status = 'pending'`;
    }

    // Usage is recorded as deltas against a high-water mark. Seeding the mark
    // from what each session has already reported is what stops a restart
    // counting a session's whole history again as new usage.
    const agents = yield* sql<{ id: string; data: string }>`SELECT id, data FROM bridge_agents`;
    for (const row of agents) {
      try {
        const agent = JSON.parse(row.data) as {
          tokens?: number;
          processedTokens?: number;
          costUsd?: number;
          lastSeenAt?: string;
        };
        const tokens = Math.max(0, agent.processedTokens ?? agent.tokens ?? 0);
        const cost = Math.max(0, agent.costUsd ?? 0);
        yield* sql`INSERT OR IGNORE INTO bridge_usage_cursors (agent_id, tokens, cost_usd, updated_at)
                   VALUES (${row.id}, ${tokens}, ${cost}, ${agent.lastSeenAt ?? now()})`;
      } catch {
        // Same tolerance as everywhere else that reads a stored agent.
      }
    }
  }).pipe(Effect.orDie),
);
