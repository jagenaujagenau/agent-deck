import { Context, Effect, Layer, Option, Ref, Schema, SubscriptionRef } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  canonicalRuntimeEvent,
  emptyRuntimeProjection,
  projectRuntimeEvent,
  type CanonicalRuntimeEvent,
  type RuntimeProjection,
  type RuntimeRequestStatus,
} from "@agent-control-dashboard/agent-adapter";
import { mergeRecentEvents } from "../bridgeEvents";
import { scanClaudeUsage, scanCodexUsage, type TranscriptUsageRow } from "../transcriptUsage";
import {
  buildAnalytics,
  rangeCutoff,
  type ActivityRow,
  type AnalyticsReport,
  type UsageRow,
} from "./Analytics";
import { BridgeConfig } from "./Config";
import type {
  AgentEvent,
  AgentEventInput,
  AgentState,
  ControlAction,
  Heartbeat,
  PendingApproval,
  RateLimitWindow,
} from "./Domain";
import { StoredAgent, StoredCommand } from "./Domain";

import { createHash, randomBytes, randomInt } from "node:crypto";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

/** How much of a session stays in the live window; history comes from SQL. */
const AGENT_EVENT_WINDOW = 500;
const SNAPSHOT_EVENT_LIMIT = 24;
const SNAPSHOT_DETAIL_LIMIT = 400;

export class InvalidRuntimeEvent extends Schema.TaggedError<InvalidRuntimeEvent>()(
  "InvalidRuntimeEvent",
  { reason: Schema.String },
) {}

export interface AgentRecord {
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
  tokens: number;
  processedTokens?: number;
  costUsd: number;
  lastSeenAt: string;
  events: Array<AgentEvent>;
  capabilities?: Array<ControlAction>;
  rateLimits?: ReadonlyArray<RateLimitWindow>;
  pendingApproval?: PendingApproval;
  isDemo?: boolean;
}

export interface Command {
  id: string;
  agentId: string;
  action: ControlAction;
  value?: string;
  createdAt: string;
  acknowledgedAt?: string;
}

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

const cardEvent = (event: AgentEvent) => {
  const { diff: _diff, command: _command, ...rest } = event;
  return {
    ...rest,
    // A runtime may send detail as null rather than omitting it; both mean absent.
    detail: rest.detail == null ? undefined : clip(rest.detail, SNAPSHOT_DETAIL_LIMIT),
  };
};

/**
 * A usage figure as it arrives from a runtime, reduced to a number the deck can
 * render. A runtime may omit it, send null, or send NaN when its own accounting
 * failed; all three mean "no figure", and the previous behaviour of every one
 * was to fall back rather than display nonsense.
 */
const decodeStoredAgent = Schema.decodeUnknownOption(StoredAgent);
const decodeStoredCommand = Schema.decodeUnknownOption(StoredCommand);

/**
 * Turns a decoded row back into the record the bridge mutates.
 *
 * Decoding yields readonly collections, which is right for something read off
 * disk and wrong for the live window that events are appended to, so the
 * copy is made once here rather than at each append.
 */
const toAgentRecord = (stored: Schema.Schema.Type<typeof StoredAgent>): AgentRecord => ({
  ...stored,
  runtime: stored.runtime ?? undefined,
  runtimeProtocol: stored.runtimeProtocol ?? undefined,
  objective: stored.objective ?? undefined,
  progress: stored.progress ?? undefined,
  processedTokens: stored.processedTokens ?? undefined,
  events: [...stored.events],
  capabilities: stored.capabilities ? [...stored.capabilities] : undefined,
  rateLimits: stored.rateLimits ?? undefined,
  pendingApproval: stored.pendingApproval ?? undefined,
  isDemo: stored.isDemo ?? undefined,
});

/** A command receipt row, as the device reads it back. */
export interface CommandReceiptRow {
  command_id: string;
  status: string;
  error: string | null;
  result_sequence: number | null;
  updated_at: string;
}

/** One session's heartbeat compared against what its runtime events project. */
export interface ProjectionParityRow {
  agentId: string;
  runtime: string;
  projectionSequence: number | null;
  heartbeat: { state: AgentState; task: string; tokens: number; processedTokens: number };
  projection: {
    state: string;
    task: string;
    tokens: number | null;
    processedTokens: number | null;
  } | null;
  stateMatches: boolean;
}

/** What a stored request row holds: a runtime event's payload, or an approval. */
type RequestData = PendingApproval | CanonicalRuntimeEvent["payload"];

const usageNumber = (value: number | null | undefined, fallback: number): number =>
  value != null && Number.isFinite(value) ? value : fallback;

const runtimeFor = (agent: Pick<AgentRecord, "name" | "runtime">) => {
  if (agent.runtime) return agent.runtime;
  if (agent.name.startsWith("Claude")) return "claude";
  if (agent.name.startsWith("Codex")) return "codex";
  if (agent.name.startsWith("Pi")) return "pi";
  return "other";
};

export class BridgeState extends Context.Service<
  BridgeState,
  {
    readonly revision: SubscriptionRef.SubscriptionRef<number>;
    readonly snapshot: Effect.Effect<Record<string, unknown>>;
    readonly heartbeat: (input: Heartbeat) => Effect.Effect<AgentRecord>;
    readonly addEvent: (
      agentId: string,
      event: AgentEventInput,
    ) => Effect.Effect<AgentEvent | undefined>;
    readonly ingestRuntimeEvent: (
      value: unknown,
    ) => Effect.Effect<{ sequence: number; event: CanonicalRuntimeEvent }, InvalidRuntimeEvent>;
    readonly control: (
      agentId: string,
      action: ControlAction,
      value?: string,
      commandId?: string,
    ) => Effect.Effect<Command | undefined>;
    readonly supportsControl: (
      agentId: string,
      action: ControlAction,
    ) => Effect.Effect<boolean | undefined>;
    readonly hasPendingApproval: (agentId: string) => Effect.Effect<boolean>;
    readonly pendingCommands: (
      agentId: string,
      after?: string,
    ) => Effect.Effect<ReadonlyArray<Command>>;
    readonly acknowledge: (
      agentId: string,
      commandId: string,
    ) => Effect.Effect<Command | undefined>;
    readonly requestStatus: (
      agentId: string,
      requestId: string,
    ) => Effect.Effect<{ status: RuntimeRequestStatus; value?: unknown } | undefined>;
    readonly resolveRuntimeRequest: (
      agentId: string,
      requestId: string,
      status: RuntimeRequestStatus,
      value?: unknown,
    ) => Effect.Effect<boolean>;
    readonly setSlashCommands: (agentId: string, commands: unknown) => Effect.Effect<void>;
    readonly commandReceipt: (commandId: string) => Effect.Effect<CommandReceiptRow | undefined>;
    readonly analytics: (
      range: string,
      project?: string,
      timeZone?: string,
    ) => Effect.Effect<AnalyticsReport>;
    readonly projectionParity: Effect.Effect<ReadonlyArray<ProjectionParityRow>>;
    readonly pair: (
      code: string,
      deviceName: string,
    ) => Effect.Effect<{ id: string; token: string; name: string; createdAt: string } | undefined>;
    readonly revokeDevice: (token: string) => Effect.Effect<boolean>;
    readonly createPairingCode: Effect.Effect<void>;
  }
>()("agent-deck/server/BridgeState") {
  static readonly layer = Layer.effect(
    BridgeState,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* BridgeConfig;
      // The revision is the SSE stream's cursor and the snapshot's sequence.
      // Restarting at zero would send every connected device a sequence lower
      // than the one it already holds, so it continues where it left off.
      const storedRevision = yield* sql<{ value: string }>`
        SELECT value FROM bridge_meta WHERE key = 'revision'`.pipe(Effect.orDie);
      const revision = yield* SubscriptionRef.make(Number(storedRevision[0]?.value ?? 0) || 0);
      const agentsRef = yield* Ref.make(new Map<string, AgentRecord>());
      const commandsRef = yield* Ref.make(new Map<string, Command>());

      /** Restores the live window from SQL so a restart does not blank the deck. */
      const agentRows = yield* sql<{
        id: string;
        data: string;
      }>`SELECT id, data FROM bridge_agents`.pipe(Effect.orDie);
      const restored = new Map<string, AgentRecord>();
      for (const row of agentRows) {
        try {
          const stored = decodeStoredAgent(JSON.parse(row.data));
          if (Option.isSome(stored)) restored.set(row.id, toAgentRecord(stored.value));
        } catch {
          // A row written by an incompatible build is skipped rather than
          // taking the whole bridge down at startup.
        }
      }
      yield* Ref.set(agentsRef, restored);

      const commandRows = yield* sql<{
        id: string;
        data: string;
      }>`SELECT id, data FROM bridge_commands`.pipe(Effect.orDie);
      const restoredCommands = new Map<string, Command>();
      for (const row of commandRows) {
        try {
          const stored = decodeStoredCommand(JSON.parse(row.data));
          if (Option.isSome(stored)) {
            restoredCommands.set(row.id, {
              ...stored.value,
              value: stored.value.value ?? undefined,
              acknowledgedAt: stored.value.acknowledgedAt ?? undefined,
            });
          }
        } catch {
          /* Same tolerance as agents. */
        }
      }
      yield* Ref.set(commandsRef, restoredCommands);

      /** Bumping the revision is what wakes every SSE subscriber. */
      const changed = Effect.gen(function* () {
        const next = yield* SubscriptionRef.updateAndGet(revision, (value: number) => value + 1);
        yield* sql`INSERT INTO bridge_meta (key, value) VALUES ('revision', ${String(next)})
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`.pipe(Effect.orDie);
      });

      const persistAgent = (agent: AgentRecord) =>
        sql`INSERT INTO bridge_agents (id, data, updated_at)
            VALUES (${agent.id}, ${JSON.stringify(agent)}, ${now()})
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`.pipe(
          Effect.orDie,
        );

      const persistCommand = (command: Command) =>
        sql`INSERT INTO bridge_commands (id, agent_id, data, updated_at)
            VALUES (${command.id}, ${command.agentId}, ${JSON.stringify(command)}, ${now()})
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`.pipe(
          Effect.orDie,
        );

      const persistSessionEvent = (agentId: string, event: AgentEvent) =>
        sql`INSERT INTO bridge_session_events (id, agent_id, kind, summary, detail, tool, command, path, options, created_at)
            VALUES (${event.id}, ${agentId}, ${event.kind}, ${event.summary}, ${event.detail ?? null},
                    ${event.tool ?? null}, ${event.command ?? null}, ${event.path ?? null},
                    ${event.options?.length ? JSON.stringify(event.options) : null}, ${event.createdAt})
            ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary, detail = excluded.detail,
              tool = excluded.tool, command = excluded.command, path = excluded.path, options = excluded.options`.pipe(
          Effect.orDie,
        );

      const persistFileChange = (agentId: string, event: AgentEvent) =>
        event.diff === undefined
          ? Effect.void
          : sql`INSERT INTO bridge_file_changes (id, agent_id, path, tool, diff, created_at)
                VALUES (${event.id}, ${agentId}, ${event.path ?? null}, ${event.tool ?? null}, ${event.diff}, ${event.createdAt})
                ON CONFLICT(id) DO UPDATE SET path = excluded.path, tool = excluded.tool, diff = excluded.diff`.pipe(
              Effect.orDie,
            );

      const persistActivity = (agent: AgentRecord, event: AgentEvent) =>
        sql`INSERT OR IGNORE INTO bridge_activity (id, agent_id, project, runtime, kind, created_at)
            VALUES (${event.id}, ${agent.id}, ${agent.project}, ${runtimeFor(agent)}, ${event.kind}, ${event.createdAt})`.pipe(
          Effect.orDie,
        );

      const appendRuntimeEvent = Effect.fn("BridgeState.appendRuntimeEvent")(function* (
        event: CanonicalRuntimeEvent,
      ) {
        yield* sql`INSERT OR IGNORE INTO bridge_runtime_events (id, agent_id, type, data, created_at)
                   VALUES (${event.id}, ${event.agentId}, ${event.type}, ${JSON.stringify(event)}, ${event.createdAt})`;
        const seqRows = yield* sql<{ sequence: number }>`
          SELECT sequence FROM bridge_runtime_events WHERE id = ${event.id}`;
        const sequence = seqRows[0]?.sequence ?? 0;
        if (sequence > 0) {
          const projRows = yield* sql<{ data: string }>`
            SELECT data FROM bridge_runtime_projections WHERE agent_id = ${event.agentId}`;
          let projection = emptyRuntimeProjection(event.agentId);
          if (projRows[0]) {
            try {
              projection = JSON.parse(projRows[0].data) as RuntimeProjection;
            } catch {
              /* Rebuild from this event. */
            }
          }
          const projected = projectRuntimeEvent(projection, event, sequence);
          yield* sql`INSERT INTO bridge_runtime_projections (agent_id, sequence, data, updated_at)
                     VALUES (${event.agentId}, ${projected.sequence}, ${JSON.stringify(projected)}, ${projected.updatedAt})
                     ON CONFLICT(agent_id) DO UPDATE SET sequence = excluded.sequence, data = excluded.data,
                       updated_at = excluded.updated_at
                     WHERE excluded.sequence >= bridge_runtime_projections.sequence`;
        }
        return sequence;
      }, Effect.orDie);

      const recordFact = (
        agentId: string,
        type: CanonicalRuntimeEvent["type"],
        payload: CanonicalRuntimeEvent["payload"],
        options: { id?: string; requestId?: string; itemId?: string } = {},
      ) => {
        const event: CanonicalRuntimeEvent = {
          id: options.id ?? makeId(),
          agentId,
          type,
          createdAt: now(),
          payload,
        };
        // Only the lifecycles that have them carry these, and the projector
        // reading these back treats a present-but-undefined key differently
        // from an absent one.
        if (options.requestId !== undefined) event.requestId = options.requestId;
        if (options.itemId !== undefined) event.itemId = options.itemId;
        return appendRuntimeEvent(event);
      };

      const upsertRequest = (
        agentId: string,
        requestId: string,
        kind: "approval" | "user-input",
        status: RuntimeRequestStatus,
        data: RequestData,
        createdAt: string,
        expiresAt?: string,
      ) =>
        sql`INSERT INTO bridge_requests (request_id, agent_id, kind, status, data, created_at, expires_at, resolved_at)
            VALUES (${requestId}, ${agentId}, ${kind}, ${status}, ${JSON.stringify(data)}, ${createdAt},
                    ${expiresAt ?? null}, ${status === "pending" ? null : now()})
            ON CONFLICT(request_id) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind,
              status = CASE WHEN bridge_requests.status = 'pending' THEN excluded.status ELSE bridge_requests.status END,
              data = excluded.data, expires_at = excluded.expires_at,
              resolved_at = CASE WHEN bridge_requests.status = 'pending' THEN excluded.resolved_at ELSE bridge_requests.resolved_at END`.pipe(
          Effect.orDie,
        );

      const setRequestStatus = Effect.fn("BridgeState.setRequestStatus")(function* (
        requestId: string,
        status: RuntimeRequestStatus,
        value?: unknown,
      ) {
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM bridge_requests WHERE request_id = ${requestId}`;
        let data: Record<string, unknown> = {};
        try {
          if (rows[0]) data = JSON.parse(rows[0].data) as Record<string, unknown>;
        } catch {
          /* Preserve an empty payload. */
        }
        if (value !== undefined) data.resolutionValue = value;
        yield* sql`UPDATE bridge_requests SET status = ${status}, data = ${JSON.stringify(data)}, resolved_at = ${now()}
                   WHERE request_id = ${requestId} AND status = 'pending'`;
      }, Effect.orDie);

      const pendingApprovalFor = Effect.fn("BridgeState.pendingApprovalFor")(function* (
        agentId: string,
      ) {
        const rows = yield* sql<{
          request_id: string;
          data: string;
          created_at: string;
          expires_at: string | null;
        }>`SELECT request_id, data, created_at, expires_at FROM bridge_requests
           WHERE agent_id = ${agentId} AND kind = 'approval' AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`;
        const row = rows[0];
        if (row === undefined) return undefined;
        if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
          yield* setRequestStatus(row.request_id, "expired");
          yield* recordFact(
            agentId,
            "request.resolved",
            { status: "expired" },
            {
              requestId: row.request_id,
              id: `request-resolved:${row.request_id}`,
            },
          );
          yield* changed;
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
            expiresAt:
              typeof data.expiresAt === "string"
                ? data.expiresAt
                : (row.expires_at ?? new Date(Date.now() + 10 * 60_000).toISOString()),
          } satisfies PendingApproval;
        } catch {
          return undefined;
        }
      }, Effect.orDie);

      const syncApprovalRequest = Effect.fn("BridgeState.syncApprovalRequest")(function* (
        agent: AgentRecord,
        previous?: AgentRecord,
      ) {
        if (agent.pendingApproval) {
          yield* upsertRequest(
            agent.id,
            agent.pendingApproval.id,
            "approval",
            "pending",
            agent.pendingApproval,
            agent.pendingApproval.createdAt,
            agent.pendingApproval.expiresAt,
          );
          if (
            previous?.pendingApproval &&
            previous.pendingApproval.id !== agent.pendingApproval.id
          ) {
            yield* setRequestStatus(previous.pendingApproval.id, "unavailable");
          }
        } else if (previous?.pendingApproval) {
          yield* setRequestStatus(
            previous.pendingApproval.id,
            Date.parse(previous.pendingApproval.expiresAt) <= Date.now()
              ? "expired"
              : "unavailable",
          );
        }
      });

      const snapshot = Effect.gen(function* () {
        const timestamp = Date.now();
        const agents = yield* Ref.get(agentsRef);
        // One query for every projection rather than one per agent.
        const projRows = yield* sql<{ agent_id: string; data: string }>`
          SELECT agent_id, data FROM bridge_runtime_projections`.pipe(Effect.orDie);
        const projections = new Map<string, RuntimeProjection>();
        for (const row of projRows) {
          try {
            projections.set(row.agent_id, JSON.parse(row.data) as RuntimeProjection);
          } catch {
            /* Compatibility projection remains available. */
          }
        }
        const approvals = new Map<string, PendingApproval>();
        for (const agent of agents.values()) {
          const approval = yield* pendingApprovalFor(agent.id);
          if (approval) approvals.set(agent.id, approval);
        }
        const rendered = [...agents.values()].map((agent) => {
          const projection =
            agent.runtimeProtocol === "canonical-v1" ? projections.get(agent.id) : undefined;
          const activeProjection =
            projection && projection.state === agent.state ? projection : undefined;
          return {
            ...agent,
            ...(projection
              ? {
                  projectionSequence: projection.sequence,
                  projectionParity: activeProjection != null,
                }
              : {}),
            ...(activeProjection
              ? { state: activeProjection.state as AgentState, task: activeProjection.task }
              : {}),
            tokens: activeProjection?.usageKnown
              ? activeProjection.contextTokens
              : Number.isFinite(agent.tokens)
                ? agent.tokens
                : 0,
            processedTokens: activeProjection?.usageKnown
              ? activeProjection.processedTokens
              : Number.isFinite(agent.processedTokens)
                ? agent.processedTokens
                : agent.tokens,
            costUsd: Number.isFinite(agent.costUsd) ? agent.costUsd : 0,
            // A session that stopped reporting is offline; idle sessions get a
            // longer grace period because they legitimately go quiet.
            state:
              !agent.isDemo &&
              timestamp - Date.parse(agent.lastSeenAt) >
                ((activeProjection?.state ?? agent.state) === "idle" ? 10 * 60_000 : 45_000)
                ? ("offline" as const)
                : (activeProjection?.state ?? agent.state),
            pendingApproval: approvals.get(agent.id),
            events: agent.events.slice(-SNAPSHOT_EVENT_LIMIT).reverse().map(cardEvent),
          };
        });
        const usageRows = yield* sql<{ tokens: number; cost_usd: number }>`
          SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
          FROM bridge_usage_deltas`.pipe(Effect.orDie);
        const historical = usageRows[0] ?? { tokens: 0, cost_usd: 0 };
        return {
          sequence: yield* SubscriptionRef.get(revision),
          bridge: { status: "connected", name: config.name, timestamp: now() },
          summary: {
            active: rendered.filter((agent) =>
              ["running", "waiting", "paused"].includes(agent.state),
            ).length,
            waiting: rendered.filter((agent) => agent.state === "waiting").length,
            errors: rendered.filter((agent) => agent.state === "error").length,
            tokens: historical.tokens,
            costUsd: historical.cost_usd,
          },
          agents: rendered,
        };
      });

      const heartbeat = Effect.fn("BridgeState.heartbeat")(function* (input: Heartbeat) {
        const agents = yield* Ref.get(agentsRef);
        const previous = agents.get(input.id);
        // The wire form and the stored record are different shapes: a runtime
        // may leave a field out or send null, while the record the deck reads
        // is total. Translating field by field is what makes that difference
        // explicit rather than something every later reader has to re-check.
        const tokens = usageNumber(input.tokens, 0);
        const agent: AgentRecord = {
          id: input.id,
          name: input.name,
          project: input.project,
          model: input.model,
          runtime: input.runtime ?? undefined,
          runtimeProtocol: input.runtimeProtocol ?? undefined,
          state: input.state,
          task: input.task,
          objective: input.objective ?? undefined,
          progress: input.progress ?? undefined,
          tokens,
          processedTokens: usageNumber(input.processedTokens, tokens),
          costUsd: usageNumber(input.costUsd, 0),
          lastSeenAt: now(),
          events: mergeRecentEvents(previous?.events ?? [], [...(input.events ?? [])]),
          capabilities: input.capabilities ? [...input.capabilities] : undefined,
          rateLimits: input.rateLimits ?? undefined,
          pendingApproval: input.pendingApproval ?? undefined,
        };
        const processedTokens = usageNumber(agent.processedTokens, agent.tokens);
        yield* persistAgent(agent);
        yield* syncApprovalRequest(agent, previous);
        // Usage is stored as deltas against a high-water cursor: a runtime that
        // re-reports the same totals must not double-count.
        const cursorRows = yield* sql<{ tokens: number; cost_usd: number }>`
          SELECT tokens, cost_usd FROM bridge_usage_cursors WHERE agent_id = ${agent.id}`.pipe(
          Effect.orDie,
        );
        const tokenDelta = Math.max(0, processedTokens - (cursorRows[0]?.tokens ?? 0));
        const costDelta = Math.max(0, agent.costUsd - (cursorRows[0]?.cost_usd ?? 0));
        if (tokenDelta > 0 || costDelta > 0) {
          yield* sql`INSERT INTO bridge_usage_deltas (agent_id, project, runtime, tokens, cost_usd, created_at)
                     VALUES (${agent.id}, ${agent.project}, ${runtimeFor(agent)}, ${tokenDelta}, ${costDelta}, ${now()})`.pipe(
            Effect.orDie,
          );
        }
        yield* sql`INSERT INTO bridge_usage_cursors (agent_id, tokens, cost_usd, updated_at)
                   VALUES (${agent.id}, ${processedTokens}, ${agent.costUsd}, ${now()})
                   ON CONFLICT(agent_id) DO UPDATE SET tokens = MAX(tokens, excluded.tokens),
                     cost_usd = MAX(cost_usd, excluded.cost_usd), updated_at = excluded.updated_at`.pipe(
          Effect.orDie,
        );
        if (
          agent.runtimeProtocol !== "canonical-v1" &&
          (!previous ||
            previous.state !== agent.state ||
            previous.task !== agent.task ||
            previous.objective !== agent.objective)
        ) {
          yield* recordFact(agent.id, "session.state.changed", {
            state: agent.state,
            task: agent.task,
            objective: agent.objective ?? null,
          });
        }
        if (
          agent.runtimeProtocol !== "canonical-v1" &&
          agent.pendingApproval &&
          previous?.pendingApproval?.id !== agent.pendingApproval.id
        ) {
          yield* recordFact(
            agent.id,
            "request.opened",
            {
              kind: "approval",
              tool: agent.pendingApproval.tool,
              detail: agent.pendingApproval.detail,
              expiresAt: agent.pendingApproval.expiresAt,
            },
            {
              requestId: agent.pendingApproval.id,
              id: `request-opened:${agent.pendingApproval.id}`,
            },
          );
        }
        yield* changed;
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agent.id, agent));
        return agent;
      });

      const addEvent = Effect.fn("BridgeState.addEvent")(function* (
        agentId: string,
        event: AgentEventInput,
      ) {
        const agents = yield* Ref.get(agentsRef);
        const previous = agents.get(agentId);
        if (previous === undefined) return undefined;
        const existingIndex = event.id
          ? previous.events.findIndex((item) => item.id === event.id)
          : -1;
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
        const agent: AgentRecord = {
          ...previous,
          events: events.slice(-AGENT_EVENT_WINDOW),
          lastSeenAt: now(),
        };
        yield* persistAgent(agent);
        yield* persistActivity(agent, created);
        yield* persistFileChange(agentId, created);
        yield* persistSessionEvent(agentId, created);
        if (agent.runtimeProtocol !== "canonical-v1") {
          yield* recordFact(
            agentId,
            created.kind === "error"
              ? "runtime.error"
              : existingIndex >= 0
                ? "item.updated"
                : "item.completed",
            {
              kind: created.kind,
              summary: created.summary,
              detail: created.detail ?? null,
              tool: created.tool ?? null,
            },
            { id: `activity:${created.id}`, itemId: created.id },
          );
        }
        yield* changed;
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agentId, agent));
        return created;
      });

      const ingestRuntimeEvent = Effect.fn("BridgeState.ingestRuntimeEvent")(function* (
        value: unknown,
      ) {
        const event = yield* Effect.try({
          try: () => canonicalRuntimeEvent(value),
          catch: (cause) =>
            new InvalidRuntimeEvent({
              reason: cause instanceof Error ? cause.message : "Invalid runtime event",
            }),
        });
        const sequence = yield* appendRuntimeEvent(event);
        // A request's kind comes from the event type, never the payload: the
        // two lifecycles resolve through different endpoints.
        if (event.type === "request.opened" || event.type === "user-input.requested") {
          if (!event.requestId) {
            return yield* new InvalidRuntimeEvent({
              reason: "Request lifecycle events require requestId",
            });
          }
          const kind = event.type === "request.opened" ? "approval" : "user-input";
          const expiresAt =
            typeof event.payload.expiresAt === "string" ? event.payload.expiresAt : undefined;
          yield* upsertRequest(
            event.agentId,
            event.requestId,
            kind,
            "pending",
            event.payload,
            event.createdAt,
            expiresAt,
          );
        }
        if (event.type === "request.resolved" || event.type === "user-input.resolved") {
          if (!event.requestId) {
            return yield* new InvalidRuntimeEvent({
              reason: "Request lifecycle events require requestId",
            });
          }
          const status =
            typeof event.payload.status === "string"
              ? (event.payload.status as RuntimeRequestStatus)
              : event.type === "user-input.resolved"
                ? "answered"
                : "unavailable";
          yield* setRequestStatus(event.requestId, status);
        }
        yield* changed;
        return { sequence, event };
      });

      const hasPendingApproval = (agentId: string) =>
        Effect.map(pendingApprovalFor(agentId), (approval) => approval != null);

      const supportsControl = Effect.fn("BridgeState.supportsControl")(function* (
        agentId: string,
        action: ControlAction,
      ) {
        const agents = yield* Ref.get(agentsRef);
        const agent = agents.get(agentId);
        if (agent === undefined) return undefined;
        return !agent.capabilities || agent.capabilities.includes(action);
      });

      const control = Effect.fn("BridgeState.control")(function* (
        agentId: string,
        action: ControlAction,
        value?: string,
        commandId?: string,
      ) {
        const agents = yield* Ref.get(agentsRef);
        const existing = agents.get(agentId);
        if (
          existing === undefined ||
          (existing.capabilities && !existing.capabilities.includes(action))
        ) {
          return undefined;
        }
        const commands = yield* Ref.get(commandsRef);
        // A retried command must not queue a second action.
        if (commandId && commands.has(commandId)) return commands.get(commandId);
        if (
          (action === "approve" || action === "reject") &&
          !(yield* hasPendingApproval(agentId))
        ) {
          return undefined;
        }
        const command: Command = {
          id: commandId ?? makeId(),
          agentId,
          action,
          value,
          createdAt: now(),
        };
        yield* Ref.update(commandsRef, (map) => new Map(map).set(command.id, command));
        yield* persistCommand(command);
        yield* sql`INSERT OR REPLACE INTO bridge_command_receipts (command_id, status, updated_at)
                   VALUES (${command.id}, 'queued', ${now()})`.pipe(Effect.orDie);

        const agent: AgentRecord = { ...existing, events: [...existing.events] };
        if (action === "pause") agent.state = "paused";
        if (action === "resume") agent.state = "running";
        if (action === "stop") agent.state = "idle";
        if (action === "approve" || action === "reject") {
          const request = yield* pendingApprovalFor(agentId);
          if (request) {
            const status = action === "approve" ? "approved" : "rejected";
            yield* setRequestStatus(request.id, status);
            yield* recordFact(
              agentId,
              "request.resolved",
              { status },
              {
                requestId: request.id,
                id: `request-resolved:${request.id}`,
              },
            );
          }
          agent.state = "running";
          agent.pendingApproval = undefined;
        }
        if (["prompt", "steer", "follow_up"].includes(action) && value) {
          agent.task = value;
          agent.state = "running";
        }
        agent.events.push({
          id: makeId(),
          kind: ["prompt", "steer", "follow_up"].includes(action) ? "user" : "output",
          summary: `Remote command: ${action}`,
          detail: value,
          createdAt: now(),
        });
        yield* persistAgent(agent);
        yield* recordFact(agentId, "session.state.changed", {
          state: agent.state,
          commandId: command.id,
          action,
        });
        yield* changed;
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agentId, agent));
        return command;
      });

      const pendingCommands = Effect.fn("BridgeState.pendingCommands")(function* (
        agentId: string,
        after?: string,
      ) {
        const afterTime = after ? Date.parse(after) : 0;
        const commands = yield* Ref.get(commandsRef);
        return [...commands.values()].filter(
          (command) =>
            command.agentId === agentId &&
            !command.acknowledgedAt &&
            Date.parse(command.createdAt) > afterTime,
        );
      });

      const acknowledge = Effect.fn("BridgeState.acknowledge")(function* (
        agentId: string,
        commandId: string,
      ) {
        const commands = yield* Ref.get(commandsRef);
        const existing = commands.get(commandId);
        if (existing === undefined || existing.agentId !== agentId) return undefined;
        const command: Command = { ...existing, acknowledgedAt: now() };
        yield* Ref.update(commandsRef, (map) => new Map(map).set(commandId, command));
        yield* persistCommand(command);
        const sequence = yield* recordFact(agentId, "session.state.changed", {
          commandId,
          delivery: "acknowledged",
        });
        yield* sql`UPDATE bridge_command_receipts SET status = 'delivered', result_sequence = ${sequence},
                     updated_at = ${now()} WHERE command_id = ${commandId}`.pipe(Effect.orDie);
        yield* changed;
        return command;
      });

      const requestStatus = Effect.fn("BridgeState.requestStatus")(function* (
        agentId: string,
        requestId: string,
      ) {
        const rows = yield* sql<{
          status: RuntimeRequestStatus;
          data: string;
          expires_at: string | null;
        }>`
          SELECT status, data, expires_at FROM bridge_requests
          WHERE request_id = ${requestId} AND agent_id = ${agentId}`;
        const row = rows[0];
        if (row === undefined) return undefined;
        if (
          row.status === "pending" &&
          row.expires_at &&
          Date.parse(row.expires_at) <= Date.now()
        ) {
          yield* setRequestStatus(requestId, "expired");
          return { status: "expired" as RuntimeRequestStatus };
        }
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          /* No resolution value. */
        }
        return { status: row.status, value: data.resolutionValue };
      }, Effect.orDie);

      const canResolve = Effect.fn("BridgeState.canResolve")(function* (
        agentId: string,
        requestId: string,
        status: RuntimeRequestStatus,
      ) {
        const rows = yield* sql<{ kind: string; status: string }>`
          SELECT kind, status FROM bridge_requests WHERE request_id = ${requestId} AND agent_id = ${agentId}`;
        const row = rows[0];
        return (
          row?.status === "pending" &&
          (status !== "answered" || row.kind === "user-input") &&
          (!["approved", "rejected"].includes(status) || row.kind === "approval")
        );
      }, Effect.orDie);

      const resolveRuntimeRequest = Effect.fn("BridgeState.resolveRuntimeRequest")(function* (
        agentId: string,
        requestId: string,
        status: RuntimeRequestStatus,
        value?: unknown,
      ) {
        if (!(yield* canResolve(agentId, requestId, status))) return false;
        yield* setRequestStatus(requestId, status, value);
        yield* recordFact(
          agentId,
          "request.resolved",
          {
            status,
            ...(value === undefined ? {} : { value }),
          },
          { requestId, id: `request-resolved:${requestId}` },
        );
        yield* changed;
        return true;
      });

      const setSlashCommands = Effect.fn("BridgeState.setSlashCommands")(
        function* (agentId: string, commands: unknown) {
          yield* sql`INSERT INTO bridge_slash_commands (agent_id, commands, updated_at)
                   VALUES (${agentId}, ${JSON.stringify(commands ?? [])}, ${now()})
                   ON CONFLICT(agent_id) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at`;
        },
        Effect.orDie,
        Effect.asVoid,
      );

      const commandReceipt = Effect.fn("BridgeState.commandReceipt")(function* (commandId: string) {
        const rows = yield* sql<CommandReceiptRow>`
          SELECT command_id, status, error, result_sequence, updated_at
          FROM bridge_command_receipts WHERE command_id = ${commandId}`;
        return rows[0];
      }, Effect.orDie);

      const transcriptCacheRef = yield* Ref.make<
        | {
            cutoff: string;
            expiresAt: number;
            rows: ReadonlyArray<TranscriptUsageRow>;
            claudeFiles: number;
            codexFiles: number;
            duplicates: number;
          }
        | undefined
      >(undefined);

      /**
       * Scanning every transcript is expensive, so a scan is reused for five
       * minutes. A cached scan that reaches further back than the current
       * cutoff is still usable — it is filtered down rather than redone.
       */
      const transcriptUsage = Effect.fn("BridgeState.transcriptUsage")(function* (cutoff: string) {
        const cached = yield* Ref.get(transcriptCacheRef);
        if (cached && cached.expiresAt > Date.now() && cached.cutoff <= cutoff) {
          return { ...cached, rows: cached.rows.filter((row) => row.created_at >= cutoff) };
        }
        const [claude, codex] = yield* Effect.all(
          [
            Effect.promise(() => scanClaudeUsage(cutoff)),
            Effect.promise(() => scanCodexUsage(cutoff)),
          ],
          { concurrency: 2 },
        );
        const fresh = {
          cutoff,
          expiresAt: Date.now() + 5 * 60_000,
          rows: [...claude.rows, ...codex.rows],
          claudeFiles: claude.files,
          codexFiles: codex.files,
          duplicates: claude.duplicates,
        };
        yield* Ref.set(transcriptCacheRef, fresh);
        return fresh;
      });

      const analytics = Effect.fn("BridgeState.analytics")(function* (
        range: string,
        project?: string,
        timeZone = "UTC",
      ) {
        const generatedAt = now();
        const { cutoff } = rangeCutoff(range, Date.parse(generatedAt));
        const ledgerUsage = yield* sql<UsageRow>`
          SELECT agent_id, project, runtime, tokens, cost_usd, created_at
          FROM bridge_usage_deltas WHERE created_at >= ${cutoff} ORDER BY created_at`.pipe(
          Effect.orDie,
        );
        const activityRows = yield* sql<ActivityRow>`
          SELECT agent_id, project, runtime, kind, created_at
          FROM bridge_activity WHERE created_at >= ${cutoff} ORDER BY created_at`.pipe(
          Effect.orDie,
        );
        const transcript = yield* transcriptUsage(cutoff);
        const agents = yield* Ref.get(agentsRef);
        return buildAnalytics({
          range,
          project,
          timeZone,
          generatedAt,
          ledgerUsage,
          activityRows,
          transcript,
          agents: [...agents.values()].map((agent) => ({
            id: agent.id,
            project: agent.project,
            runtime: runtimeFor(agent),
            state: agent.state,
            lastSeenAt: agent.lastSeenAt,
            rateLimits: agent.rateLimits as any,
          })),
        });
      });

      const projectionParity = Effect.gen(function* () {
        const agents = yield* Ref.get(agentsRef);
        const canonical = [...agents.values()].filter(
          (agent) => agent.runtimeProtocol === "canonical-v1",
        );
        const out: Array<ProjectionParityRow> = [];
        for (const agent of canonical) {
          const rows = yield* sql<{ sequence: number; data: string }>`
            SELECT sequence, data FROM bridge_runtime_projections WHERE agent_id = ${agent.id}`.pipe(
            Effect.orDie,
          );
          const row = rows[0];
          let projection: RuntimeProjection | undefined;
          try {
            if (row) projection = JSON.parse(row.data) as RuntimeProjection;
          } catch {
            /* Report missing below. */
          }
          out.push({
            agentId: agent.id,
            runtime: runtimeFor(agent),
            projectionSequence: row?.sequence ?? null,
            heartbeat: {
              state: agent.state,
              task: agent.task,
              tokens: agent.tokens,
              processedTokens: agent.processedTokens ?? agent.tokens,
            },
            projection: projection
              ? {
                  state: projection.state,
                  task: projection.task,
                  tokens: projection.usageKnown ? projection.contextTokens : null,
                  processedTokens: projection.usageKnown ? projection.processedTokens : null,
                }
              : null,
            stateMatches: projection?.state === agent.state,
          });
        }
        return out;
      });

      const pairingFailuresRef = yield* Ref.make(0);

      /**
       * Pairing consumes a one-time code. Repeated failures lock pairing until
       * a new code is issued, so a six-digit code cannot be brute-forced.
       */
      const pair = Effect.fn("BridgeState.pair")(function* (code: string, deviceName: string) {
        if ((yield* Ref.get(pairingFailuresRef)) >= 10) return undefined;
        const codeHash = tokenHash(code);
        const rows = yield* sql<{ expires_at: string; consumed_at: string | null }>`
          SELECT expires_at, consumed_at FROM bridge_pairing_codes WHERE code_hash = ${codeHash}`;
        const pairing = rows[0];
        if (!pairing || pairing.consumed_at || Date.parse(pairing.expires_at) < Date.now()) {
          yield* Ref.update(pairingFailuresRef, (count) => count + 1);
          return undefined;
        }
        yield* Ref.set(pairingFailuresRef, 0);
        const id = makeId();
        const token = `${randomBytes(24).toString("base64url")}.${id}`;
        const timestamp = now();
        yield* sql`UPDATE bridge_pairing_codes SET consumed_at = ${timestamp} WHERE code_hash = ${codeHash}`;
        yield* sql`INSERT INTO bridge_devices (id, name, token_hash, created_at, last_seen_at)
                   VALUES (${id}, ${deviceName}, ${tokenHash(token)}, ${timestamp}, ${timestamp})`;
        return { id, token, name: deviceName, createdAt: timestamp };
      }, Effect.orDie);

      const revokeDevice = Effect.fn("BridgeState.revokeDevice")(function* (token: string) {
        const before = yield* sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM bridge_devices WHERE token_hash = ${tokenHash(token)} AND revoked_at IS NULL`;
        if ((before[0]?.n ?? 0) === 0) return false;
        yield* sql`UPDATE bridge_devices SET revoked_at = ${now()}
                   WHERE token_hash = ${tokenHash(token)} AND revoked_at IS NULL`;
        return true;
      }, Effect.orDie);

      const createPairingCode = Effect.gen(function* () {
        yield* sql`DELETE FROM bridge_pairing_codes WHERE consumed_at IS NULL`;
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        yield* sql`INSERT INTO bridge_pairing_codes (code_hash, expires_at) VALUES (${tokenHash(code)}, ${expiresAt})`;
        yield* Ref.set(pairingFailuresRef, 0);
        yield* Effect.log(`Pairing code: ${code} (expires in 10 minutes)`);
      }).pipe(Effect.orDie, Effect.asVoid);

      // A bridge with no paired device is unreachable from a phone, so a code
      // is issued on every start — the same as the deployed bridge.
      yield* createPairingCode;

      return BridgeState.of({
        revision,
        snapshot,
        heartbeat,
        addEvent,
        ingestRuntimeEvent,
        control,
        supportsControl,
        hasPendingApproval,
        pendingCommands,
        acknowledge,
        requestStatus,
        resolveRuntimeRequest,
        setSlashCommands,
        commandReceipt,
        analytics,
        projectionParity,
        pair,
        revokeDevice,
        createPairingCode,
      });
    }),
  );
}
