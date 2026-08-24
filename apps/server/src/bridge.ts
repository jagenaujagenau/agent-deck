import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ClaudeSdkManagedRuntimeAdapter, canonicalRuntimeEvent, emptyRuntimeProjection, projectRuntimeEvent, type CanonicalRuntimeEvent, type DurableManagedRequest, type ManagedRequestStore, type ManagedSession, type RuntimeProjection, type RuntimeRequestStatus } from "@agent-control-dashboard/agent-adapter";
import { scanClaudeUsage, scanCodexUsage, type TranscriptUsageRow } from "./transcriptUsage";
import { mergeRecentEvents } from "./bridgeEvents";

export type AgentState = "idle" | "running" | "waiting" | "paused" | "error" | "offline";
export type ControlAction = "pause" | "resume" | "stop" | "approve" | "reject" | "prompt" | "steer" | "follow_up";

type AgentEvent = {
  id: string;
  kind: "thought" | "tool" | "output" | "warning" | "error" | "question" | "user";
  summary: string;
  detail?: string;
  createdAt: string;
  tool?: string;
  path?: string;
  command?: string;
  diff?: string;
  options?: string[];
};

type RateLimitWindow = { id: string; label: string; usedPercent: number; resetsAt?: string; account?: string };
type PendingApproval = { id: string; tool: string; detail: string; createdAt: string; expiresAt: string };

type AgentRecord = {
  id: string;
  name: string;
  project: string;
  model: string;
  runtime?: string;
  runtimeProtocol?: "canonical-v1";
  state: AgentState;
  task: string;
  objective?: string;
  progress?: number;
  /** Current context pressure. */
  tokens: number;
  /** Monotonic processed usage for historical analytics. */
  processedTokens?: number;
  costUsd: number;
  lastSeenAt: string;
  events: AgentEvent[];
  capabilities?: ControlAction[];
  rateLimits?: RateLimitWindow[];
  pendingApproval?: PendingApproval;
  isDemo?: boolean;
};

type Command = {
  id: string;
  agentId: string;
  action: ControlAction;
  value?: string;
  createdAt: string;
  acknowledgedAt?: string;
};

const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Serialized to every connected device; both callers hand it straight to JSON. */
type SnapshotPayload = {
  sequence: number;
  bridge: { status: string; name: string; timestamp: string };
  summary: { active: number; waiting: number; errors: number; tokens: number; costUsd: number };
  agents: Array<Record<string, unknown>>;
};

/**
 * A snapshot feeds live cards, and it is re-sent in full on every change, so it carries only what a
 * card can show. Whole histories and diff bodies are large, change constantly, and are already
 * served per session by `/history` and `/changes` — including them here would push hundreds of
 * kilobytes to every connected device on every event.
 */
const SNAPSHOT_EVENT_LIMIT = 24;
const SNAPSHOT_DETAIL_LIMIT = 400;
const HISTORY_TOOL_DETAIL_LIMIT = 240;
const HISTORY_COMMAND_LIMIT = 2_000;

function cardEvent(event: AgentEvent): AgentEvent {
  const detail = event.detail && event.detail.length > SNAPSHOT_DETAIL_LIMIT
    ? `${event.detail.slice(0, SNAPSHOT_DETAIL_LIMIT - 1).trimEnd()}…`
    : event.detail;
  // `diff` and `command` bodies are the bulk of an event and are never rendered on a card.
  const { diff: _diff, command: _command, ...rest } = event;
  return { ...rest, detail };
}

class BridgeStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly commands = new Map<string, Command>();
  private readonly database: Database;
  private revision = 0;
  private pairingFailures = 0;
  private transcriptUsageCache?: { cutoff: string; expiresAt: number; rows: TranscriptUsageRow[]; claudeFiles: number; codexFiles: number; duplicates: number };

  getRevision() {
    return this.revision;
  }

  private snapshotCache?: { revision: number; value: SnapshotPayload };

  private changed() {
    this.revision += 1;
    this.database.run("INSERT INTO bridge_meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(this.revision)]);
  }

  private appendRuntimeEvent(event: CanonicalRuntimeEvent) {
    this.database.run(
      "INSERT OR IGNORE INTO bridge_runtime_events (id, agent_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
      [event.id, event.agentId, event.type, JSON.stringify(event), event.createdAt],
    );
    const row = this.database.query<{ sequence: number }, [string]>(
      "SELECT sequence FROM bridge_runtime_events WHERE id = ?",
    ).get(event.id);
    const sequence = row?.sequence ?? 0;
    if (sequence > 0) {
      const projectionRow = this.database.query<{ data: string }, [string]>("SELECT data FROM bridge_runtime_projections WHERE agent_id = ?").get(event.agentId);
      let projection = emptyRuntimeProjection(event.agentId);
      if (projectionRow) {
        try { projection = JSON.parse(projectionRow.data) as RuntimeProjection; } catch { /* Rebuild from this event. */ }
      }
      const projected = projectRuntimeEvent(projection, event, sequence);
      this.database.run(
        "INSERT INTO bridge_runtime_projections (agent_id, sequence, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET sequence = excluded.sequence, data = excluded.data, updated_at = excluded.updated_at WHERE excluded.sequence >= bridge_runtime_projections.sequence",
        [event.agentId, projected.sequence, JSON.stringify(projected), projected.updatedAt],
      );
    }
    return sequence;
  }

  private recordFact(agentId: string, type: CanonicalRuntimeEvent["type"], payload: Record<string, unknown>, options: { id?: string; requestId?: string; itemId?: string } = {}) {
    return this.appendRuntimeEvent({
      id: options.id ?? makeId(), agentId, type, createdAt: now(), payload,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.itemId ? { itemId: options.itemId } : {}),
    });
  }

  private persistAgent(agent: AgentRecord) {
    this.database.run(
      "INSERT INTO bridge_agents (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      [agent.id, JSON.stringify(agent), now()],
    );
  }

  private persistCommand(command: Command) {
    this.database.run(
      "INSERT INTO bridge_commands (id, agent_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      [command.id, command.agentId, JSON.stringify(command), now()],
    );
  }

  private runtimeFor(agent: Pick<AgentRecord, "name" | "runtime">) {
    if (agent.runtime) return agent.runtime;
    if (agent.name.startsWith("Claude")) return "claude";
    if (agent.name.startsWith("Codex")) return "codex";
    if (agent.name.startsWith("Pi")) return "pi";
    return "other";
  }

  private persistSessionEvent(agentId: string, event: AgentEvent) {
    this.database.run(
      `INSERT INTO bridge_session_events (id, agent_id, kind, summary, detail, tool, command, path, options, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary, detail = excluded.detail,
         tool = excluded.tool, command = excluded.command, path = excluded.path, options = excluded.options`,
      [event.id, agentId, event.kind, event.summary, event.detail ?? null, event.tool ?? null, event.command ?? null,
       event.path ?? null, event.options?.length ? JSON.stringify(event.options) : null, event.createdAt],
    );
  }

  /**
   * A session's history for the detail view: every conversational turn it ever recorded, plus a
   * recent slice of everything else.
   *
   * A plain "most recent N events" is not enough — tool activity outnumbers conversation by an
   * order of magnitude, so a flat cap silently drops the messages while keeping the chatter.
   */
  sessionHistory(agentId: string) {
    const conversation = this.sessionEvents(agentId, 500, true);
    const recent = this.sessionEvents(agentId, 600);
    const byId = new Map(conversation.map((event) => [event.id, event]));
    for (const event of recent) byId.set(event.id, event);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A session's retained history, oldest first, without the diff bodies. */
  sessionEvents(agentId: string, limit = 600, conversationOnly = false) {
    const rows = this.database.query<{ id: string; kind: string; summary: string; detail: string | null; tool: string | null; command: string | null; path: string | null; options: string | null; created_at: string }, [string, number]>(
      `SELECT id, kind, summary, detail, tool, command, path, options, created_at FROM bridge_session_events
       WHERE agent_id = ?${conversationOnly ? ` AND (kind = 'user' OR summary LIKE 'Remote command:%'
             OR (kind = 'thought' AND summary = 'Received instruction')
             OR (kind = 'output' AND tool IS NULL AND command IS NULL))` : ""}
       ORDER BY created_at DESC LIMIT ?`,
    ).all(agentId, limit);
    return rows.reverse().map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      // A tool event's detail is the rendered tool call, which no tab shows: the conversation
      // excludes tool events and the terminal renders `command`. Keeping the head of it preserves
      // debuggability while dropping the bulk of a session's payload.
      detail: row.tool && row.detail && row.detail.length > HISTORY_TOOL_DETAIL_LIMIT
        ? `${row.detail.slice(0, HISTORY_TOOL_DETAIL_LIMIT - 1).trimEnd()}…`
        : row.detail ?? undefined,
      tool: row.tool ?? undefined,
      // The terminal card renders the command, so it is kept — but a multi-kilobyte heredoc is
      // already unreadable on a phone, and a session's worth of them is most of this payload.
      command: row.command && row.command.length > HISTORY_COMMAND_LIMIT
        ? `${row.command.slice(0, HISTORY_COMMAND_LIMIT - 1).trimEnd()}…`
        : row.command ?? undefined,
      path: row.path ?? undefined,
      options: row.options ? JSON.parse(row.options) as string[] : undefined,
      createdAt: row.created_at,
    }));
  }

  private persistFileChange(agentId: string, event: AgentEvent) {
    if (!event.diff) return;
    this.database.run(
      "INSERT INTO bridge_file_changes (id, agent_id, path, tool, diff, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, tool = excluded.tool, diff = excluded.diff",
      [event.id, agentId, event.path ?? null, event.tool ?? null, event.diff, event.createdAt],
    );
  }

  setSlashCommands(agentId: string, commands: unknown) {
    this.database.run(
      "INSERT INTO bridge_slash_commands (agent_id, commands, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at",
      [agentId, JSON.stringify(commands ?? []), now()],
    );
  }

  slashCommands(agentId: string) {
    const row = this.database.query<{ commands: string }, [string]>("SELECT commands FROM bridge_slash_commands WHERE agent_id = ?").get(agentId);
    if (!row) return [];
    try { return JSON.parse(row.commands) as unknown[]; } catch { return []; }
  }

  /** Every file change this session produced, oldest first — not just the ones still in the window. */
  fileChanges(agentId: string) {
    return this.database.query<{ id: string; path: string | null; tool: string | null; diff: string; created_at: string }, [string]>(
      "SELECT id, path, tool, diff, created_at FROM bridge_file_changes WHERE agent_id = ? ORDER BY created_at",
    ).all(agentId).map((row) => ({
      id: row.id,
      kind: "output" as const,
      summary: row.tool ? `${row.tool} completed` : "File change",
      path: row.path ?? undefined,
      tool: row.tool ?? undefined,
      diff: row.diff,
      createdAt: row.created_at,
    }));
  }

  private persistActivity(agent: AgentRecord, event: AgentEvent) {
    this.database.run(
      "INSERT OR IGNORE INTO bridge_activity (id, agent_id, project, runtime, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [event.id, agent.id, agent.project, this.runtimeFor(agent), event.kind, event.createdAt],
    );
  }

  private upsertRequest(agentId: string, requestId: string, kind: "approval" | "user-input", status: RuntimeRequestStatus, data: Record<string, unknown>, createdAt: string, expiresAt?: string) {
    this.database.run(
      `INSERT INTO bridge_requests (request_id, agent_id, kind, status, data, created_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind,
         status = CASE WHEN bridge_requests.status = 'pending' THEN excluded.status ELSE bridge_requests.status END,
         data = excluded.data, expires_at = excluded.expires_at,
         resolved_at = CASE WHEN bridge_requests.status = 'pending' THEN excluded.resolved_at ELSE bridge_requests.resolved_at END`,
      [requestId, agentId, kind, status, JSON.stringify(data), createdAt, expiresAt ?? null, status === "pending" ? null : now()],
    );
  }

  private setRequestStatus(requestId: string, status: RuntimeRequestStatus, value?: unknown) {
    const row = this.database.query<{ data: string }, [string]>("SELECT data FROM bridge_requests WHERE request_id = ?").get(requestId);
    let data: Record<string, unknown> = {};
    try { if (row) data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* Preserve an empty payload. */ }
    if (value !== undefined) data.resolutionValue = value;
    this.database.run("UPDATE bridge_requests SET status = ?, data = ?, resolved_at = ? WHERE request_id = ? AND status = 'pending'", [status, JSON.stringify(data), now(), requestId]);
  }

  openManagedRequest(request: DurableManagedRequest) {
    this.database.transaction(() => {
      this.upsertRequest(request.agentId, request.requestId, request.kind, "pending", request.payload, request.createdAt, request.expiresAt);
      this.changed();
    })();
  }

  resolveManagedRequest(requestId: string, status: RuntimeRequestStatus, value?: unknown) {
    this.setRequestStatus(requestId, status, value);
  }

  /**
   * Resolves a request owned by a runtime the bridge does not host — a hook session blocked inside
   * its own process. There is nothing in-process to hand the answer to, so it is recorded durably
   * and the runtime collects it by polling `requestStatus`.
   */
  resolveRuntimeRequest(agentId: string, requestId: string, status: RuntimeRequestStatus, value?: unknown) {
    if (!this.canResolveManagedRequest(agentId, requestId, status)) return false;
    this.database.transaction(() => {
      this.setRequestStatus(requestId, status, value);
      this.recordFact(agentId, "request.resolved", { status, ...(value === undefined ? {} : { value }) }, { requestId, id: `request-resolved:${requestId}` });
      this.changed();
    })();
    return true;
  }

  /** One-shot read of a request's outcome, for a runtime polling for its answer. */
  requestStatus(agentId: string, requestId: string) {
    const row = this.database.query<{ status: RuntimeRequestStatus; data: string; expires_at: string | null }, [string, string]>(
      "SELECT status, data, expires_at FROM bridge_requests WHERE request_id = ? AND agent_id = ?",
    ).get(requestId, agentId);
    if (!row) return undefined;
    if (row.status === "pending" && row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      this.setRequestStatus(requestId, "expired");
      return { status: "expired" as RuntimeRequestStatus };
    }
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* No resolution value. */ }
    return { status: row.status, value: data.resolutionValue };
  }

  canResolveManagedRequest(agentId: string, requestId: string, status: RuntimeRequestStatus) {
    const row = this.database.query<{ kind: string; status: string }, [string, string]>(
      "SELECT kind, status FROM bridge_requests WHERE request_id = ? AND agent_id = ?",
    ).get(requestId, agentId);
    return row?.status === "pending" && (status !== "answered" || row.kind === "user-input") && (!["approved", "rejected"].includes(status) || row.kind === "approval");
  }

  async waitForManagedRequest(requestId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const row = this.database.query<{ status: RuntimeRequestStatus; data: string; expires_at: string | null }, [string]>(
        "SELECT status, data, expires_at FROM bridge_requests WHERE request_id = ?",
      ).get(requestId);
      if (!row) throw new Error(`Managed request disappeared: ${requestId}`);
      if (row.status !== "pending") {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* No resolution value. */ }
        return { status: row.status, value: data.resolutionValue };
      }
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        this.setRequestStatus(requestId, "expired");
        return { status: "expired" as const };
      }
      await Bun.sleep(250);
    }
    throw new Error("Managed request aborted");
  }

  private pendingApprovalFor(agentId: string): PendingApproval | undefined {
    const row = this.database.query<{ request_id: string; data: string; created_at: string; expires_at: string | null }, [string]>(
      "SELECT request_id, data, created_at, expires_at FROM bridge_requests WHERE agent_id = ? AND kind = 'approval' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    ).get(agentId);
    if (!row) return undefined;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      this.setRequestStatus(row.request_id, "expired");
      this.recordFact(agentId, "request.resolved", { status: "expired" }, { requestId: row.request_id, id: `request-resolved:${row.request_id}` });
      this.changed();
      return undefined;
    }
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      if (typeof data.tool !== "string" || typeof data.detail !== "string") return undefined;
      return {
        id: row.request_id,
        tool: data.tool,
        detail: data.detail,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : row.created_at,
        expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : row.expires_at ?? new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    } catch { return undefined; }
  }

  private syncApprovalRequest(agent: AgentRecord, previous?: AgentRecord) {
    if (agent.pendingApproval) {
      this.upsertRequest(agent.id, agent.pendingApproval.id, "approval", "pending", agent.pendingApproval, agent.pendingApproval.createdAt, agent.pendingApproval.expiresAt);
      if (previous?.pendingApproval && previous.pendingApproval.id !== agent.pendingApproval.id) this.setRequestStatus(previous.pendingApproval.id, "unavailable");
    } else if (previous?.pendingApproval) {
      this.setRequestStatus(previous.pendingApproval.id, Date.parse(previous.pendingApproval.expiresAt) <= Date.now() ? "expired" : "unavailable");
    }
  }

  private createPairingCode() {
    this.database.run("DELETE FROM bridge_pairing_codes WHERE consumed_at IS NULL");
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.database.run("INSERT INTO bridge_pairing_codes (code_hash, expires_at) VALUES (?, ?)", [tokenHash(code), expiresAt]);
    this.pairingFailures = 0;
    console.log(`[Agent Deck] Pairing code: ${code} (expires in 10 minutes)`);
  }

  pair(code: string, deviceName: string) {
    if (this.pairingFailures >= 10) return undefined;
    const codeHash = tokenHash(code);
    const pairing = this.database.query<{ expires_at: string; consumed_at: string | null }, [string]>(
      "SELECT expires_at, consumed_at FROM bridge_pairing_codes WHERE code_hash = ?",
    ).get(codeHash);
    if (!pairing || pairing.consumed_at || Date.parse(pairing.expires_at) < Date.now()) {
      this.pairingFailures += 1;
      return undefined;
    }

    this.pairingFailures = 0;
    const id = makeId();
    const token = `${randomBytes(24).toString("base64url")}.${id}`;
    const timestamp = now();
    this.database.transaction(() => {
      this.database.run("UPDATE bridge_pairing_codes SET consumed_at = ? WHERE code_hash = ?", [timestamp, codeHash]);
      this.database.run(
        "INSERT INTO bridge_devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        [id, deviceName, tokenHash(token), timestamp, timestamp],
      );
    })();
    return { id, token, name: deviceName, createdAt: timestamp };
  }

  authorizeDevice(token: string, requiredScope: "read" | "control") {
    const device = this.database.query<{ id: string; scopes: string }, [string]>(
      "SELECT id, scopes FROM bridge_devices WHERE token_hash = ? AND revoked_at IS NULL",
    ).get(tokenHash(token));
    if (!device || !device.scopes.split(',').includes(requiredScope)) return false;
    this.database.run("UPDATE bridge_devices SET last_seen_at = ? WHERE id = ?", [now(), device.id]);
    return true;
  }

  revokeDevice(token: string) {
    const result = this.database.run(
      "UPDATE bridge_devices SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      [now(), tokenHash(token)],
    );
    return result.changes > 0;
  }

  constructor() {
    const databaseUrl = process.env.DATABASE_URL ?? "file:../../local.db";
    this.database = new Database(databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl, { create: true });
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run("PRAGMA busy_timeout = 5000");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_commands (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT, scopes TEXT NOT NULL DEFAULT 'read,control')");
    if (!this.database.query<{ name: string }, []>("PRAGMA table_info(bridge_devices)").all().some((column) => column.name === "scopes")) {
      this.database.run("ALTER TABLE bridge_devices ADD COLUMN scopes TEXT NOT NULL DEFAULT 'read,control'");
    }
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_pairing_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_usage_deltas (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, project TEXT NOT NULL, runtime TEXT NOT NULL, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL)");
    this.database.run("CREATE INDEX IF NOT EXISTS bridge_usage_created_idx ON bridge_usage_deltas(created_at)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_usage_cursors (agent_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, updated_at TEXT NOT NULL)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_activity (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project TEXT NOT NULL, runtime TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)");
    // File changes are kept apart from the rolling event history: the Changes tab shows a whole
    // session, and events age out of the snapshot window long before a session ends.
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_file_changes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, path TEXT, tool TEXT, diff TEXT NOT NULL, created_at TEXT NOT NULL)");
    // What a session can be asked to run by name. Reported once per session and served on demand:
    // it is far too large to ride every heartbeat or snapshot.
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_slash_commands (agent_id TEXT PRIMARY KEY, commands TEXT NOT NULL, updated_at TEXT NOT NULL)");
    // The snapshot carries a rolling window sized for live cards. A session view shows whole
    // histories — conversation, reasoning, terminal — so those are kept here instead of being
    // whatever survived the window. Diff bodies stay out; they have their own table.
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_session_events (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, tool TEXT, command TEXT, path TEXT, options TEXT, created_at TEXT NOT NULL)");
    this.database.run("CREATE INDEX IF NOT EXISTS bridge_session_events_agent_idx ON bridge_session_events(agent_id, created_at)");
    this.database.run("CREATE INDEX IF NOT EXISTS bridge_file_changes_agent_idx ON bridge_file_changes(agent_id, created_at)");
    this.database.run("CREATE INDEX IF NOT EXISTS bridge_activity_created_idx ON bridge_activity(created_at)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_runtime_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)");
    this.database.run("CREATE INDEX IF NOT EXISTS bridge_runtime_events_agent_sequence_idx ON bridge_runtime_events(agent_id, sequence)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_runtime_projections (agent_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_requests (request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, resolved_at TEXT)");
    this.database.run("CREATE INDEX IF NOT EXISTS bridge_requests_agent_status_idx ON bridge_requests(agent_id, status)");
    this.database.run("CREATE TABLE IF NOT EXISTS bridge_command_receipts (command_id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT, result_sequence INTEGER, updated_at TEXT NOT NULL)");
    this.revision = Number(this.database.query<{ value: string }, [string]>("SELECT value FROM bridge_meta WHERE key = ?").get("revision")?.value ?? 0);

    for (const row of this.database.query<{ id: string; data: string }, []>("SELECT id, data FROM bridge_agents").all()) {
      try { this.agents.set(row.id, JSON.parse(row.data) as AgentRecord); } catch { /* Ignore corrupt bridge rows. */ }
    }
    for (const row of this.database.query<{ id: string; data: string }, []>("SELECT id, data FROM bridge_commands").all()) {
      try { this.commands.set(row.id, JSON.parse(row.data) as Command); } catch { /* Ignore corrupt bridge rows. */ }
    }
    // Tool hooks may run from nested directories. Historical facts belong to the Agent's stable project, not that transient cwd.
    this.database.run("UPDATE bridge_activity SET project = (SELECT json_extract(data, '$.project') FROM bridge_agents WHERE bridge_agents.id = bridge_activity.agent_id) WHERE EXISTS (SELECT 1 FROM bridge_agents WHERE bridge_agents.id = bridge_activity.agent_id AND json_extract(data, '$.project') IS NOT NULL AND json_extract(data, '$.project') != '')");
    this.database.run("UPDATE bridge_usage_deltas SET project = (SELECT json_extract(data, '$.project') FROM bridge_agents WHERE bridge_agents.id = bridge_usage_deltas.agent_id) WHERE EXISTS (SELECT 1 FROM bridge_agents WHERE bridge_agents.id = bridge_usage_deltas.agent_id AND json_extract(data, '$.project') IS NOT NULL AND json_extract(data, '$.project') != '')");
    if ((this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM bridge_runtime_projections").get()?.count ?? 0) === 0) {
      for (const row of this.database.query<{ data: string }, []>("SELECT data FROM bridge_runtime_events ORDER BY sequence").all()) {
        try { this.appendRuntimeEvent(canonicalRuntimeEvent(JSON.parse(row.data))); } catch { /* Ignore legacy corrupt event rows. */ }
      }
    }
    for (const agent of this.agents.values()) {
      if (agent.id.startsWith("managed-") && agent.state !== "offline") {
        agent.state = "offline";
        agent.task = "Managed host restarted";
        this.database.run("UPDATE bridge_requests SET status = 'unavailable', resolved_at = ? WHERE agent_id = ? AND status = 'pending'", [now(), agent.id]);
        this.recordFact(agent.id, "session.state.changed", { state: "offline", task: agent.task }, { id: `managed-recovery:${agent.id}:${this.revision}` });
        this.persistAgent(agent);
      }
      if (/^session[_ -]?end$/i.test(agent.task)) {
        agent.state = "offline";
        agent.task = "Session ended";
        this.persistAgent(agent);
      }
      this.syncApprovalRequest(agent);
      for (const event of agent.events) {
        this.persistActivity(agent, event);
        // Backfill: sessions that ran before these tables existed still carry whatever remains in
        // their retained event history.
        this.persistFileChange(agent.id, event);
        this.persistSessionEvent(agent.id, event);
      }
    }
    const usageRows = this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM bridge_usage_deltas").get()?.count ?? 0;
    if (usageRows === 0) {
      const insert = this.database.prepare("INSERT INTO bridge_usage_deltas (agent_id, project, runtime, tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      this.database.transaction(() => {
        for (const agent of this.agents.values()) {
          const tokens = Number.isFinite(agent.processedTokens) ? agent.processedTokens! : Number.isFinite(agent.tokens) ? agent.tokens : 0;
          const cost = Number.isFinite(agent.costUsd) ? agent.costUsd : 0;
          if (tokens > 0 || cost > 0) insert.run(agent.id, agent.project, this.runtimeFor(agent), tokens, cost, agent.lastSeenAt);
        }
      })();
    }
    const cursor = this.database.prepare("INSERT OR IGNORE INTO bridge_usage_cursors (agent_id, tokens, cost_usd, updated_at) VALUES (?, ?, ?, ?)");
    this.database.transaction(() => {
      for (const agent of this.agents.values()) cursor.run(agent.id, Math.max(0, agent.processedTokens ?? agent.tokens), Math.max(0, agent.costUsd), agent.lastSeenAt);
    })();
    this.createPairingCode();

    if (process.env.BRIDGE_DEMO_AGENTS === "true" && this.agents.size === 0) {
      const timestamp = now();
      this.agents.set("pi-dashboard", {
        id: "pi-dashboard",
        name: "Dashboard Builder",
        project: "agent-control-dashboard",
        model: "Claude Sonnet",
        state: "running",
        task: "Building the Android control surface",
        progress: 0.68,
        tokens: 18_420,
        costUsd: 1.84,
        lastSeenAt: timestamp,
        isDemo: true,
        events: [
          { id: makeId(), kind: "tool", summary: "Editing Android project", detail: "Creating the phone and Wear OS clients", createdAt: timestamp },
          { id: makeId(), kind: "thought", summary: "Designing bridge protocol", createdAt: timestamp },
        ],
      });
      this.agents.set("reviewer", {
        id: "reviewer",
        name: "Review Agent",
        project: "agent-control-dashboard",
        model: "GPT-5",
        state: "waiting",
        task: "Approval needed to apply database migration",
        tokens: 6_810,
        costUsd: 0.71,
        lastSeenAt: timestamp,
        isDemo: true,
        events: [{ id: makeId(), kind: "warning", summary: "Waiting for approval", detail: "Apply migration 0002_agent_runs.sql?", createdAt: timestamp }],
      });
      this.agents.set("tests", {
        id: "tests",
        name: "Test Runner",
        project: "agent-control-dashboard",
        model: "Local",
        state: "idle",
        task: "All 84 checks passed",
        progress: 1,
        tokens: 0,
        costUsd: 0,
        lastSeenAt: timestamp,
        isDemo: true,
        events: [{ id: makeId(), kind: "output", summary: "84 checks passed", createdAt: timestamp }],
      });
    }
  }

  snapshot(): SnapshotPayload {
    // Every connected device asks for the same snapshot on the same revision — the SSE loop calls
    // this once per client per change. Building it once per revision keeps that from scaling with
    // the number of watchers.
    if (this.snapshotCache?.revision === this.revision) return this.snapshotCache.value;
    const timestamp = Date.now();
    // One query for every projection rather than one per agent.
    const projections = new Map<string, RuntimeProjection>();
    for (const row of this.database.query<{ agent_id: string; data: string }, []>("SELECT agent_id, data FROM bridge_runtime_projections").all()) {
      try { projections.set(row.agent_id, JSON.parse(row.data) as RuntimeProjection); } catch { /* Compatibility projection remains available. */ }
    }
    const approvals = new Map<string, PendingApproval>();
    for (const agent of this.agents.values()) {
      const approval = this.pendingApprovalFor(agent.id);
      if (approval) approvals.set(agent.id, approval);
    }
    const agents = [...this.agents.values()].map((agent) => {
      const projection = agent.runtimeProtocol === "canonical-v1" ? projections.get(agent.id) : undefined;
      const activeProjection = projection && projection.state === agent.state ? projection : undefined;
      return {
      ...agent,
      ...(projection ? { projectionSequence: projection.sequence, projectionParity: activeProjection != null } : {}),
      ...(activeProjection ? { state: activeProjection.state as AgentState, task: activeProjection.task } : {}),
      tokens: activeProjection?.usageKnown ? activeProjection.contextTokens : Number.isFinite(agent.tokens) ? agent.tokens : 0,
      processedTokens: activeProjection?.usageKnown ? activeProjection.processedTokens : Number.isFinite(agent.processedTokens) ? agent.processedTokens : agent.tokens,
      costUsd: Number.isFinite(agent.costUsd) ? agent.costUsd : 0,
      state: !agent.isDemo && timestamp - Date.parse(agent.lastSeenAt) > ((activeProjection?.state ?? agent.state) === "idle" ? 10 * 60_000 : 45_000) ? "offline" as const : activeProjection?.state ?? agent.state,
      pendingApproval: approvals.get(agent.id),
      events: agent.events.slice(-SNAPSHOT_EVENT_LIMIT).reverse().map(cardEvent),
    };
    });
    const active = agents.filter((agent) => ["running", "waiting", "paused"].includes(agent.state)).length;
    const historical = this.database.query<{ tokens: number; cost_usd: number }, []>(
      "SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM bridge_usage_deltas",
    ).get() ?? { tokens: 0, cost_usd: 0 };
    const value = {
      sequence: this.revision,
      bridge: { status: "connected", name: process.env.BRIDGE_NAME ?? "Local bridge", timestamp: now() },
      summary: {
        active,
        waiting: agents.filter((agent) => agent.state === "waiting").length,
        errors: agents.filter((agent) => agent.state === "error").length,
        tokens: historical.tokens,
        costUsd: historical.cost_usd,
      },
      agents,
    };
    this.snapshotCache = { revision: this.revision, value };
    return value;
  }

  heartbeat(input: Omit<AgentRecord, "events" | "lastSeenAt"> & { events?: AgentEvent[] }) {
    const previous = this.agents.get(input.id);
    const agent: AgentRecord = {
      ...input,
      tokens: Number.isFinite(input.tokens) ? input.tokens : 0,
      processedTokens: Number.isFinite(input.processedTokens) ? input.processedTokens : input.tokens,
      costUsd: Number.isFinite(input.costUsd) ? input.costUsd : 0,
      lastSeenAt: now(),
      events: mergeRecentEvents(previous?.events ?? [], input.events ?? []),
    };
    const processedTokens = Number.isFinite(agent.processedTokens) ? agent.processedTokens! : agent.tokens;
    this.database.transaction(() => {
      this.persistAgent(agent);
      this.syncApprovalRequest(agent, previous);
      const cursor = this.database.query<{ tokens: number; cost_usd: number }, [string]>("SELECT tokens, cost_usd FROM bridge_usage_cursors WHERE agent_id = ?").get(agent.id);
      const tokenHighWater = cursor?.tokens ?? 0;
      const costHighWater = cursor?.cost_usd ?? 0;
      const tokenDelta = Math.max(0, processedTokens - tokenHighWater);
      const costDelta = Math.max(0, agent.costUsd - costHighWater);
      if (tokenDelta > 0 || costDelta > 0) {
        this.database.run(
          "INSERT INTO bridge_usage_deltas (agent_id, project, runtime, tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [agent.id, agent.project, this.runtimeFor(agent), tokenDelta, costDelta, now()],
        );
      }
      this.database.run(
        "INSERT INTO bridge_usage_cursors (agent_id, tokens, cost_usd, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET tokens = MAX(tokens, excluded.tokens), cost_usd = MAX(cost_usd, excluded.cost_usd), updated_at = excluded.updated_at",
        [agent.id, processedTokens, agent.costUsd, now()],
      );
      if (agent.runtimeProtocol !== "canonical-v1" && (!previous || previous.state !== agent.state || previous.task !== agent.task || previous.objective !== agent.objective)) {
        this.recordFact(agent.id, "session.state.changed", { state: agent.state, task: agent.task, objective: agent.objective ?? null });
      }
      if (agent.runtimeProtocol !== "canonical-v1" && agent.pendingApproval && previous?.pendingApproval?.id !== agent.pendingApproval.id) {
        this.recordFact(agent.id, "request.opened", { kind: "approval", tool: agent.pendingApproval.tool, detail: agent.pendingApproval.detail, expiresAt: agent.pendingApproval.expiresAt }, { requestId: agent.pendingApproval.id, id: `request-opened:${agent.pendingApproval.id}` });
      }
      this.changed();
    })();
    this.agents.set(agent.id, agent);
    return agent;
  }

  addEvent(agentId: string, event: Omit<AgentEvent, "createdAt"> & { id?: string }) {
    const previous = this.agents.get(agentId);
    if (!previous) return undefined;
    const existingIndex = event.id ? previous.events.findIndex((item) => item.id === event.id) : -1;
    const existing = existingIndex >= 0 ? previous.events[existingIndex] : undefined;
    const created: AgentEvent = {
      ...existing,
      ...event,
      id: event.id ?? makeId(),
      createdAt: existing?.createdAt ?? now(),
    };
    const events = [...previous.events];
    if (existingIndex >= 0) events[existingIndex] = created;
    else events.push(created);
    const agent = { ...previous, events: events.slice(-500), lastSeenAt: now() };
    this.database.transaction(() => {
      this.persistAgent(agent);
      this.persistActivity(agent, created);
      this.persistFileChange(agentId, created);
      this.persistSessionEvent(agentId, created);
      if (agent.runtimeProtocol !== "canonical-v1") {
        this.recordFact(
          agentId,
          created.kind === "error" ? "runtime.error" : existingIndex >= 0 ? "item.updated" : "item.completed",
          { kind: created.kind, summary: created.summary, detail: created.detail ?? null, tool: created.tool ?? null },
          { id: `activity:${created.id}`, itemId: created.id },
        );
      }
      this.changed();
    })();
    this.agents.set(agentId, agent);
    return created;
  }

  ingestRuntimeEvent(value: unknown) {
    const event = canonicalRuntimeEvent(value);
    let sequence = 0;
    this.database.transaction(() => {
      sequence = this.appendRuntimeEvent(event);
      if (event.type === "request.opened" || event.type === "user-input.requested") {
        if (!event.requestId) throw new Error("Request lifecycle events require requestId");
        const kind = event.type === "request.opened" ? "approval" : "user-input";
        const expiresAt = typeof event.payload.expiresAt === "string" ? event.payload.expiresAt : undefined;
        this.upsertRequest(event.agentId, event.requestId, kind, "pending", event.payload, event.createdAt, expiresAt);
      }
      if (event.type === "request.resolved" || event.type === "user-input.resolved") {
        if (!event.requestId) throw new Error("Request lifecycle events require requestId");
        const status = typeof event.payload.status === "string" ? event.payload.status as RuntimeRequestStatus : event.type === "user-input.resolved" ? "answered" : "unavailable";
        this.setRequestStatus(event.requestId, status);
      }
      this.changed();
    })();
    return { sequence, event };
  }

  projectionParity() {
    return [...this.agents.values()].filter((agent) => agent.runtimeProtocol === "canonical-v1").map((agent) => {
      const row = this.database.query<{ sequence: number; data: string }, [string]>("SELECT sequence, data FROM bridge_runtime_projections WHERE agent_id = ?").get(agent.id);
      let projection: RuntimeProjection | undefined;
      try { if (row) projection = JSON.parse(row.data) as RuntimeProjection; } catch { /* Report missing below. */ }
      return {
        agentId: agent.id,
        runtime: this.runtimeFor(agent),
        projectionSequence: row?.sequence ?? null,
        heartbeat: { state: agent.state, task: agent.task, tokens: agent.tokens, processedTokens: agent.processedTokens ?? agent.tokens },
        projection: projection ? { state: projection.state, task: projection.task, tokens: projection.usageKnown ? projection.contextTokens : null, processedTokens: projection.usageKnown ? projection.processedTokens : null } : null,
        stateMatches: projection?.state === agent.state,
      };
    });
  }

  private async transcriptUsage(cutoff: string) {
    const cached = this.transcriptUsageCache;
    if (cached && cached.expiresAt > Date.now() && cached.cutoff <= cutoff) {
      return { ...cached, rows: cached.rows.filter((row) => row.created_at >= cutoff) };
    }
    const [claude, codex] = await Promise.all([scanClaudeUsage(cutoff), scanCodexUsage(cutoff)]);
    this.transcriptUsageCache = {
      cutoff, expiresAt: Date.now() + 5 * 60_000, rows: [...claude.rows, ...codex.rows],
      claudeFiles: claude.files, codexFiles: codex.files, duplicates: claude.duplicates,
    };
    return this.transcriptUsageCache;
  }

  async analytics(range: string, project?: string, timeZone = "UTC") {
    const durations: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };
    const selectedRange = range in durations ? range : "month";
    const cutoff = new Date(Date.now() - durations[selectedRange]! * 86_400_000).toISOString();
    const ledgerUsage = this.database.query<{ agent_id: string; project: string; runtime: string; tokens: number; cost_usd: number; created_at: string }, [string]>(
      "SELECT agent_id, project, runtime, tokens, cost_usd, created_at FROM bridge_usage_deltas WHERE created_at >= ? ORDER BY created_at",
    ).all(cutoff);
    const transcriptUsage = await this.transcriptUsage(cutoff);
    const trackedAgents = new Map([...this.agents.values()].map((agent) => [agent.id, { project: agent.project, runtime: this.runtimeFor(agent) }]));
    const trackedTranscriptRows = transcriptUsage.rows.flatMap((row) => {
      const agent = trackedAgents.get(row.agent_id);
      return agent?.runtime === row.runtime ? [{ ...row, project: agent.project }] : [];
    });
    const transcriptBackedAgents = new Set(trackedTranscriptRows.map((row) => row.agent_id));
    const usage = [...ledgerUsage.filter((row) => !transcriptBackedAgents.has(row.agent_id)), ...trackedTranscriptRows]
      .filter((row) => !project || row.project === project)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    const activity = this.database.query<{ agent_id: string; project: string; runtime: string; kind: string; created_at: string }, [string]>(
      "SELECT agent_id, project, runtime, kind, created_at FROM bridge_activity WHERE created_at >= ? ORDER BY created_at",
    ).all(cutoff).filter((row) => !project || row.project === project);
    const sessionIds = new Set([...usage.map((row) => row.agent_id), ...activity.map((row) => row.agent_id)]);
    let dayFormatter: Intl.DateTimeFormat;
    try { dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch { timeZone = "UTC"; dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
    const dayFor = (timestamp: string) => dayFormatter.format(new Date(timestamp));
    const bucketFor = (timestamp: string) => {
      const localDay = dayFor(timestamp);
      const date = new Date(`${localDay}T00:00:00.000Z`);
      if (selectedRange === "day") return `${timestamp.slice(0, 13)}:00:00.000Z`;
      if (selectedRange === "year") return `${localDay.slice(0, 7)}-01T00:00:00.000Z`;
      if (selectedRange === "quarter") {
        const day = (date.getUTCDay() + 6) % 7;
        date.setUTCDate(date.getUTCDate() - day);
        return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
      }
      return `${localDay}T00:00:00.000Z`;
    };
    const series = new Map<string, { bucket: string; tokens: number; costUsd: number; events: number }>();
    const heatmap = new Map<string, { date: string; count: number; tokens: number; costUsd: number }>();
    const projectMap = new Map<string, { project: string; tokens: number; costUsd: number; events: number; sessions: Set<string> }>();
    const runtimeMap = new Map<string, { runtime: string; tokens: number; costUsd: number; events: number }>();
    const ensureSeries = (bucket: string) => series.get(bucket) ?? { bucket, tokens: 0, costUsd: 0, events: 0 };
    for (const row of usage) {
      const bucket = bucketFor(row.created_at);
      const point = ensureSeries(bucket); point.tokens += row.tokens; point.costUsd += row.cost_usd; series.set(bucket, point);
      const date = dayFor(row.created_at); const day = heatmap.get(date) ?? { date, count: 0, tokens: 0, costUsd: 0 };
      day.tokens += row.tokens; day.costUsd += row.cost_usd; heatmap.set(date, day);
      const item = projectMap.get(row.project) ?? { project: row.project, tokens: 0, costUsd: 0, events: 0, sessions: new Set<string>() };
      item.tokens += row.tokens; item.costUsd += row.cost_usd; item.sessions.add(row.agent_id); projectMap.set(row.project, item);
      const runtime = runtimeMap.get(row.runtime) ?? { runtime: row.runtime, tokens: 0, costUsd: 0, events: 0 };
      runtime.tokens += row.tokens; runtime.costUsd += row.cost_usd; runtimeMap.set(row.runtime, runtime);
    }
    for (const row of activity) {
      const bucket = bucketFor(row.created_at); const point = ensureSeries(bucket); point.events += 1; series.set(bucket, point);
      const date = dayFor(row.created_at); const day = heatmap.get(date) ?? { date, count: 0, tokens: 0, costUsd: 0 };
      day.count += 1; heatmap.set(date, day);
      const item = projectMap.get(row.project) ?? { project: row.project, tokens: 0, costUsd: 0, events: 0, sessions: new Set<string>() };
      item.events += 1; item.sessions.add(row.agent_id); projectMap.set(row.project, item);
      const runtime = runtimeMap.get(row.runtime) ?? { runtime: row.runtime, tokens: 0, costUsd: 0, events: 0 };
      runtime.events += 1; runtimeMap.set(row.runtime, runtime);
    }
    const projects = [...new Set([
      ...projectMap.keys(),
      ...[...this.agents.values()].filter((agent) => agent.state !== "offline").map((agent) => agent.project),
    ])].sort();
    const limits = new Map<string, RateLimitWindow & { runtime: string; updatedAt: string }>();
    for (const agent of this.agents.values()) {
      if (project && agent.project !== project) continue;
      const runtime = this.runtimeFor(agent);
      for (const window of agent.rateLimits ?? []) {
        const key = `${runtime}:${window.account ?? "default"}:${window.id}`;
        const previous = limits.get(key);
        if (!previous || agent.lastSeenAt > previous.updatedAt) limits.set(key, { ...window, runtime, updatedAt: agent.lastSeenAt });
      }
    }
    const unpricedTokens = usage.reduce((sum, row) => sum + ("priced" in row && row.priced === false ? row.tokens : 0), 0);
    const totalTokens = usage.reduce((sum, row) => sum + row.tokens, 0);
    return {
      range: selectedRange,
      project: project ?? null,
      timeZone,
      generatedAt: now(),
      summary: {
        tokens: totalTokens,
        costUsd: usage.reduce((sum, row) => sum + row.cost_usd, 0),
        unpricedTokens,
        costCoveragePercent: totalTokens > 0 ? ((totalTokens - unpricedTokens) / totalTokens) * 100 : 100,
        tokenFacets: trackedTranscriptRows.reduce((totals, row) => ({
          uncachedInput: totals.uncachedInput + row.uncached_input_tokens,
          cachedInput: totals.cachedInput + row.cached_input_tokens,
          cacheCreation: totals.cacheCreation + row.cache_creation_tokens,
          output: totals.output + row.output_tokens,
          reasoning: totals.reasoning + row.reasoning_tokens,
        }), { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0 }),
        events: activity.length,
        sessions: sessionIds.size,
        activeDays: heatmap.size,
      },
      series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
      heatmap: [...heatmap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      projects: [...projectMap.values()].map((item) => ({ ...item, sessions: item.sessions.size })).sort((a, b) => b.tokens - a.tokens),
      runtimes: [...runtimeMap.values()].sort((a, b) => b.tokens - a.tokens),
      limits: [...limits.values()].sort((a, b) => b.usedPercent - a.usedPercent),
      filters: { projects },
      sources: {
        claude: { files: transcriptUsage.claudeFiles, trackedRecords: trackedTranscriptRows.filter((row) => row.runtime === "claude").length, duplicatesDropped: transcriptUsage.duplicates, mode: "global-transcript-dedup" },
        codex: { files: transcriptUsage.codexFiles, trackedRecords: trackedTranscriptRows.filter((row) => row.runtime === "codex").length, mode: "rollout-delta-fork-suppression" },
      },
    };
  }

  supportsControl(agentId: string, action: ControlAction) {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;
    return !agent.capabilities || agent.capabilities.includes(action);
  }

  hasPendingApproval(agentId: string) {
    return this.pendingApprovalFor(agentId) != null;
  }

  control(agentId: string, action: ControlAction, value?: string, commandId?: string) {
    const agent = this.agents.get(agentId);
    if (!agent || (agent.capabilities && !agent.capabilities.includes(action))) return undefined;
    if (commandId && this.commands.has(commandId)) return this.commands.get(commandId);
    if ((action === "approve" || action === "reject") && !this.hasPendingApproval(agentId)) return undefined;
    const command: Command = { id: commandId ?? makeId(), agentId, action, value, createdAt: now() };
    this.commands.set(command.id, command);
    this.persistCommand(command);
    this.database.run("INSERT OR REPLACE INTO bridge_command_receipts (command_id, status, updated_at) VALUES (?, 'queued', ?)", [command.id, now()]);
    if (action === "pause") agent.state = "paused";
    if (action === "resume") agent.state = "running";
    if (action === "stop") agent.state = "idle";
    if (action === "approve" || action === "reject") {
      const request = this.pendingApprovalFor(agentId);
      if (request) {
        const status = action === "approve" ? "approved" : "rejected";
        this.setRequestStatus(request.id, status);
        this.recordFact(agentId, "request.resolved", { status }, { requestId: request.id, id: `request-resolved:${request.id}` });
      }
      agent.state = "running";
      agent.pendingApproval = undefined;
    }
    if (["prompt", "steer", "follow_up"].includes(action) && value) {
      agent.task = value;
      agent.state = "running";
    }
    agent.events.push({ id: makeId(), kind: ["prompt", "steer", "follow_up"].includes(action) ? "user" : "output", summary: `Remote command: ${action}`, detail: value, createdAt: now() });
    this.persistAgent(agent);
    this.recordFact(agentId, "session.state.changed", { state: agent.state, commandId: command.id, action });
    this.changed();
    return command;
  }

  commandReceipt(commandId: string) {
    return this.database.query<{ command_id: string; status: string; error: string | null; result_sequence: number | null; updated_at: string }, [string]>(
      "SELECT command_id, status, error, result_sequence, updated_at FROM bridge_command_receipts WHERE command_id = ?",
    ).get(commandId);
  }

  pendingCommands(agentId: string, after?: string) {
    const afterTime = after ? Date.parse(after) : 0;
    return [...this.commands.values()].filter((command) => command.agentId === agentId && !command.acknowledgedAt && Date.parse(command.createdAt) > afterTime);
  }

  acknowledge(agentId: string, commandId: string) {
    const command = this.commands.get(commandId);
    if (!command || command.agentId !== agentId) return undefined;
    command.acknowledgedAt = now();
    this.persistCommand(command);
    const sequence = this.recordFact(agentId, "session.state.changed", { commandId, delivery: "acknowledged" });
    this.database.run("UPDATE bridge_command_receipts SET status = 'delivered', result_sequence = ?, updated_at = ? WHERE command_id = ?", [sequence, now(), commandId]);
    this.changed();
    return command;
  }
}

class ManagedRuntimeHost {
  private readonly adapter: ClaudeSdkManagedRuntimeAdapter;
  private readonly sessions = new Map<string, { session: ManagedSession; agent: AgentRecord; timer: ReturnType<typeof setInterval> }>();

  constructor(private readonly store: BridgeStore) {
    const requests: ManagedRequestStore = {
      open: async (request) => store.openManagedRequest(request),
      resolve: async (requestId, status, value) => store.resolveManagedRequest(requestId, status, value),
      waitForResolution: (requestId, signal) => store.waitForManagedRequest(requestId, signal),
    };
    this.adapter = new ClaudeSdkManagedRuntimeAdapter(requests);
  }

  available() {
    return [{ runtime: "claude", capabilities: this.adapter.capabilities, managed: true }];
  }

  async start(input: { project: string; cwd: string; model?: string; objective?: string; prompt?: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto" }) {
    if (!input.project?.trim() || !input.cwd?.startsWith("/")) throw new Error("project and an absolute cwd are required");
    const directory = await stat(input.cwd).catch(() => undefined);
    if (!directory?.isDirectory()) throw new Error("cwd does not exist or is not a directory");
    const agentId = `managed-claude-${crypto.randomUUID()}`;
    const session = await this.adapter.start({ agentId, project: input.project.trim().slice(0, 120), cwd: input.cwd, model: input.model, permissionMode: input.permissionMode });
    const agent: AgentRecord = {
      id: agentId, name: "Managed Claude", project: session.project, model: session.model, runtime: "claude", runtimeProtocol: "canonical-v1",
      state: "idle", task: "Ready", objective: input.objective?.trim().slice(0, 500), tokens: 0, processedTokens: 0, costUsd: 0,
      lastSeenAt: now(), events: [], capabilities: ["pause", "stop", "prompt", "steer", "follow_up", ...(["auto", "bypassPermissions", "dontAsk"].includes(input.permissionMode ?? "default") ? [] : ["approve" as const, "reject" as const])],
    };
    this.store.heartbeat(agent);
    const timer = setInterval(() => this.store.heartbeat(agent), 15_000);
    this.sessions.set(agentId, { session, agent, timer });
    void this.consume(agentId, session);
    if (input.prompt?.trim()) await this.adapter.send(session, input.prompt.trim());
    return { agentId, providerSessionId: session.providerSessionId, project: session.project, model: session.model, permissionMode: input.permissionMode ?? "default" };
  }

  async resolve(agentId: string, requestId: string, status: RuntimeRequestStatus, value?: unknown) {
    const managed = this.sessions.get(agentId);
    if (!managed || !this.store.canResolveManagedRequest(agentId, requestId, status)) return false;
    await this.adapter.resolveRequest(managed.session, requestId, status, value);
    return true;
  }

  async handle(command: Command) {
    const managed = this.sessions.get(command.agentId);
    if (!managed) return false;
    try {
      if (["prompt", "steer", "follow_up"].includes(command.action) && command.value) await this.adapter.send(managed.session, command.value);
      else if (command.action === "pause") await this.adapter.interrupt(managed.session);
      else if (command.action === "stop") {
        await this.adapter.stop(managed.session);
        clearInterval(managed.timer);
        this.sessions.delete(command.agentId);
      }
      // approve/reject decisions are already durable in bridge_requests; the SDK callback polls that row.
      this.store.acknowledge(command.agentId, command.id);
      return true;
    } catch (error) {
      this.store.ingestRuntimeEvent({ id: makeId(), agentId: command.agentId, type: "runtime.error", createdAt: now(), payload: { message: error instanceof Error ? error.message : String(error) } });
      return true;
    }
  }

  private async consume(agentId: string, session: ManagedSession) {
    const managed = this.sessions.get(agentId);
    if (!managed) return;
    for await (const event of this.adapter.events(session)) {
      this.store.ingestRuntimeEvent(event);
      if (event.type === "session.state.changed" && typeof event.payload.state === "string") {
        managed.agent.state = event.payload.state as AgentState;
        if (typeof event.payload.task === "string") managed.agent.task = event.payload.task;
      }
      if (event.type === "turn.completed" && typeof event.payload.costUsd === "number") managed.agent.costUsd += event.payload.costUsd;
      if (event.type === "token-usage.updated") {
        const usage = event.payload.usage as Record<string, unknown> | undefined;
        const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
        const cacheRead = typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
        const cacheWrite = typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
        const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
        const turnTokens = input + cacheRead + cacheWrite + output;
        managed.agent.tokens = turnTokens;
        managed.agent.processedTokens = (managed.agent.processedTokens ?? 0) + turnTokens;
      }
      if (event.type === "user-input.requested") {
        const questions = Array.isArray(event.payload.questions) ? event.payload.questions as Array<Record<string, unknown>> : [];
        const firstQuestion = questions[0];
        const options = questions.length === 1 && firstQuestion?.multiSelect !== true && Array.isArray(firstQuestion?.options)
          ? (firstQuestion.options as Array<Record<string, unknown>>).map((option) => String(option.label ?? "")).filter(Boolean)
          : [];
        this.store.addEvent(agentId, { id: event.requestId ?? event.id, kind: "question", summary: String(questions[0]?.question ?? "Claude needs your input"), options });
      }
      if (event.type === "item.started" || event.type === "item.completed" || event.type === "runtime.error") {
        const kind: AgentEvent["kind"] = event.type === "runtime.error" ? "error" : event.payload.kind === "tool" ? "tool" : event.payload.kind === "reasoning" ? "thought" : "output";
        const summary = kind === "thought" ? "Reasoning" : typeof event.payload.text === "string" ? event.payload.text.slice(0, 300) : typeof event.payload.tool === "string" ? `${event.payload.tool}` : event.type === "runtime.error" ? String(event.payload.message ?? "Runtime error") : "Activity";
        const toolInput = event.payload.input as Record<string, unknown> | undefined;
        const detail = (kind === "output" || kind === "thought") && typeof event.payload.text === "string" ? event.payload.text
          : toolInput ? JSON.stringify(toolInput, null, 2) : undefined;
        this.store.addEvent(agentId, {
          id: event.itemId ?? event.id, kind, summary, detail,
          tool: typeof event.payload.tool === "string" ? event.payload.tool : undefined,
          command: typeof toolInput?.command === "string" ? toolInput.command : undefined,
          path: typeof toolInput?.path === "string" ? toolInput.path : typeof toolInput?.file_path === "string" ? toolInput.file_path : undefined,
        });
      }
      this.store.heartbeat(managed.agent);
    }
  }
}

const store = new BridgeStore();
const managedRuntimeHost = new ManagedRuntimeHost(store);
export const bridgeApi = new Hono();

bridgeApi.use("/*", async (c, next) => {
  if (c.req.path.endsWith("/pair")) return next();
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const masterToken = process.env.BRIDGE_TOKEN;
  const isMaster = Boolean(masterToken && bearer === masterToken);
  const managedResolution = /^\/managed\/[^/]+\/requests\/[^/]+\/resolve$/.test(c.req.path);
  const requestResolution = /^\/agents\/[^/]+\/requests\/[^/]+\/resolve$/.test(c.req.path);
  // Reading a request's outcome is how a blocked runtime collects its answer — runtime credential
  // only. Writing the answer is a device action, so it takes the same control scope as approvals.
  const requestPolling = /^\/agents\/[^/]+\/requests\/[^/]+$/.test(c.req.path);
  const catalogPublish = c.req.method === "POST" && /^\/agents\/[^/]+\/slash-commands$/.test(c.req.path);
  const runtimeOnly = (c.req.path.startsWith("/managed/") && !managedResolution) || requestPolling || catalogPublish || /\/agents\/heartbeat$|\/agents\/[^/]+\/(events|runtime-events|commands)(\/|$)/.test(c.req.path);
  const requiredScope = c.req.path.endsWith("/control") || managedResolution || requestResolution ? "control" as const : "read" as const;
  const authorized = isMaster || (!runtimeOnly && Boolean(bearer) && store.authorizeDevice(bearer, requiredScope));
  if (!authorized && process.env.BRIDGE_REQUIRE_AUTH === "true") {
    return c.json({ error: "Pair this device or provide a valid bridge token" }, 401);
  }
  await next();
});

bridgeApi.post("/pair", async (c) => {
  const body = await c.req.json();
  if (!/^\d{6}$/.test(body?.code) || typeof body?.deviceName !== "string" || !body.deviceName.trim()) {
    return c.json({ error: "A six-digit code and device name are required" }, 400);
  }
  const device = store.pair(body.code, body.deviceName.trim().slice(0, 80));
  return device ? c.json(device, 201) : c.json({ error: "Pairing code is invalid or expired" }, 401);
});

bridgeApi.delete("/device", (c) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return store.revokeDevice(bearer) ? c.json({ revoked: true }) : c.json({ error: "Device token not found" }, 404);
});

bridgeApi.get("/snapshot", (c) => c.json(store.snapshot()));
bridgeApi.get("/managed/runtimes", (c) => c.json({ runtimes: managedRuntimeHost.available() }));
bridgeApi.post("/managed/claude/sessions", async (c) => {
  try {
    const body = await c.req.json();
    const permissionModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
    if (body?.permissionMode && !permissionModes.includes(body.permissionMode)) return c.json({ error: "Invalid permissionMode" }, 400);
    return c.json(await managedRuntimeHost.start(body), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to start managed Claude" }, 400);
  }
});
bridgeApi.get("/agents/:agentId/slash-commands", (c) => c.json({ commands: store.slashCommands(c.req.param("agentId")) }));
bridgeApi.post("/agents/:agentId/slash-commands", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body?.commands)) return c.json({ error: "commands must be an array" }, 400);
  store.setSlashCommands(c.req.param("agentId"), body.commands.slice(0, 400));
  return c.json({ stored: body.commands.length });
});

bridgeApi.get("/agents/:agentId/history", (c) => c.json({ events: store.sessionHistory(c.req.param("agentId")) }));

bridgeApi.get("/agents/:agentId/changes", (c) => c.json({ changes: store.fileChanges(c.req.param("agentId")) }));

bridgeApi.get("/agents/:agentId/requests/:requestId", (c) => {
  const request = store.requestStatus(c.req.param("agentId"), c.req.param("requestId"));
  return request ? c.json(request) : c.json({ error: "Request not found" }, 404);
});

/**
 * Answers a pending request for any runtime. A bridge-hosted session is handed the answer in
 * process; a hook session is blocked in its own process, so the answer is recorded durably and it
 * collects it by polling.
 */
bridgeApi.post("/agents/:agentId/requests/:requestId/resolve", async (c) => {
  const body = await c.req.json();
  const statuses: RuntimeRequestStatus[] = ["approved", "rejected", "answered", "expired", "unavailable"];
  if (!statuses.includes(body?.status)) return c.json({ error: "Invalid request status" }, 400);
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (body.status !== "answered" && bearer !== process.env.BRIDGE_TOKEN) return c.json({ error: "Only the runtime credential may resolve this request status" }, 403);
  const agentId = c.req.param("agentId");
  const requestId = c.req.param("requestId");
  if (await managedRuntimeHost.resolve(agentId, requestId, body.status, body.value)) return c.json({ resolved: true });
  if (store.resolveRuntimeRequest(agentId, requestId, body.status, body.value)) return c.json({ resolved: true });
  return c.json({ error: "No pending request to resolve" }, 404);
});

bridgeApi.post("/managed/:agentId/requests/:requestId/resolve", async (c) => {
  const body = await c.req.json();
  const statuses: RuntimeRequestStatus[] = ["approved", "rejected", "answered", "expired", "unavailable"];
  if (!statuses.includes(body?.status)) return c.json({ error: "Invalid request status" }, 400);
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (body.status !== "answered" && bearer !== process.env.BRIDGE_TOKEN) return c.json({ error: "Only the runtime credential may resolve this request status" }, 403);
  const resolved = await managedRuntimeHost.resolve(c.req.param("agentId"), c.req.param("requestId"), body.status, body.value);
  return resolved ? c.json({ resolved: true }) : c.json({ error: "Managed session not found" }, 404);
});
bridgeApi.get("/commands/:id/receipt", (c) => {
  const receipt = store.commandReceipt(c.req.param("id"));
  return receipt ? c.json({ commandId: receipt.command_id, status: receipt.status, error: receipt.error, resultSequence: receipt.result_sequence, updatedAt: receipt.updated_at }) : c.json({ error: "Command receipt not found" }, 404);
});
bridgeApi.get("/analytics", async (c) => c.json(await store.analytics(c.req.query("range") ?? "month", c.req.query("project"), c.req.query("timeZone") ?? "UTC")));
bridgeApi.get("/diagnostics/projection-parity", (c) => c.json({ agents: store.projectionParity() }));
bridgeApi.get("/events", (c) => streamSSE(c, async (stream) => {
  let revision = -1;
  let lastPingAt = Date.now();
  while (true) {
    const currentRevision = store.getRevision();
    if (currentRevision !== revision) {
      revision = currentRevision;
      await stream.writeSSE({ event: "snapshot", id: String(revision), data: JSON.stringify(store.snapshot()) });
    } else if (Date.now() - lastPingAt >= 15_000) {
      lastPingAt = Date.now();
      await stream.writeSSE({ event: "ping", data: String(lastPingAt) });
    }
    await stream.sleep(250);
  }
}));

bridgeApi.post("/agents/heartbeat", async (c) => {
  const body = await c.req.json();
  if (!body?.id || !body?.name || !body?.state) return c.json({ error: "id, name and state are required" }, 400);
  return c.json(store.heartbeat(body), 201);
});

bridgeApi.post("/agents/:id/events", async (c) => {
  const body = await c.req.json();
  if (!body?.kind || !body?.summary) return c.json({ error: "kind and summary are required" }, 400);
  const event = store.addEvent(c.req.param("id"), body);
  return event ? c.json(event, 201) : c.json({ error: "Agent not found" }, 404);
});

bridgeApi.post("/agents/:id/runtime-events", async (c) => {
  try {
    const body = await c.req.json();
    if (body?.agentId !== c.req.param("id")) return c.json({ error: "Runtime event agent does not match route" }, 400);
    return c.json(store.ingestRuntimeEvent(body), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid runtime event" }, 400);
  }
});

bridgeApi.post("/agents/:id/control", async (c) => {
  const body = await c.req.json();
  const allowed: ControlAction[] = ["pause", "resume", "stop", "approve", "reject", "prompt", "steer", "follow_up"];
  if (!allowed.includes(body?.action)) return c.json({ error: "Invalid action" }, 400);
  const support = store.supportsControl(c.req.param("id"), body.action);
  if (support === undefined) return c.json({ error: "Agent not found" }, 404);
  if (!support) return c.json({ error: `This runtime does not support ${body.action}` }, 409);
  if ((body.action === "approve" || body.action === "reject") && !store.hasPendingApproval(c.req.param("id"))) {
    return c.json({ error: "No approval is currently pending" }, 409);
  }
  const command = store.control(c.req.param("id"), body.action, body.value, typeof body.commandId === "string" ? body.commandId : undefined);
  if (command) void managedRuntimeHost.handle(command);
  return command ? c.json(command, 202) : c.json({ error: "Agent not found" }, 404);
});

bridgeApi.get("/agents/:id/commands", (c) => c.json({ commands: store.pendingCommands(c.req.param("id"), c.req.query("after")) }));
bridgeApi.post("/agents/:id/commands/:commandId/ack", (c) => {
  const command = store.acknowledge(c.req.param("id"), c.req.param("commandId"));
  return command ? c.json(command) : c.json({ error: "Command not found" }, 404);
});
