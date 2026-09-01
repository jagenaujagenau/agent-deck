import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  canonicalRuntimeEvent,
  type CanonicalRuntimeEvent,
  type RuntimeProjection,
  type RuntimeRequestStatus,
  type StateAuthority,
} from "@agent-control-dashboard/agent-adapter";
import { mergeRecentEvents } from "../bridgeEvents";
import { buildAnalytics, rangeCutoff, type AnalyticsReport } from "./Analytics";
import { BridgeConfig } from "./Config";
import type {
  AgentEvent,
  AgentEventInput,
  AgentState,
  ControlAction,
  Heartbeat,
  JsonValue,
  PendingApproval,
  RateLimitWindow,
} from "./Domain";
import { StoredAgent, StoredCommand } from "./Domain";
import { isMessageAction, makeCommandQueue } from "./CommandQueue";
import { makeDeviceRegistry, type PairedDevice } from "./DeviceRegistry";
import { makeRequestLedger } from "./RequestLedger";
import type { PendingQuestion, RequestLedger } from "./RequestLedger";
import { makeRuntimeEventLog } from "./RuntimeEventLog";
import { emptyTranscriptCache, makeUsageLedger, runtimeFor, usageNumber } from "./UsageLedger";

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
  /** The directory the session works in, on the bridge's machine. */
  cwd?: string;
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
  /**
   * The last moment a person looked at this session on any surface. Seen is
   * shared, not per-device: reading a conversation on the phone clears its
   * badge on the watch, the way reading a Slack channel anywhere clears it
   * everywhere. Machine reads never set it.
   */
  viewedAt?: string;
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
 * The runtime event vocabulary leaves most payload fields open, so a reader
 * that needs one field parses just that field rather than trusting the blob.
 * Decoding `Schema.String` accepts exactly the strings, which is the same
 * question the deployed bridge asked of each field before using it.
 */
const decodeString = Schema.decodeUnknownOption(Schema.String);

// The row-to-card reductions moved to the Request Ledger with the rest of the
// request lifecycle; the type stays re-exported so consumers keep one import.
export type { PendingQuestion } from "./RequestLedger";

/**
 * Turns a decoded row back into the record the bridge mutates.
 *
 * Decoding yields readonly collections, which is right for something read off
 * disk and wrong for the live window that events are appended to, so the
 * copy is made once here rather than at each append.
 */
const toAgentRecord = (stored: Schema.Schema.Type<typeof StoredAgent>): AgentRecord => ({
  ...stored,
  cwd: stored.cwd ?? undefined,
  runtime: stored.runtime ?? undefined,
  runtimeProtocol: stored.runtimeProtocol ?? undefined,
  objective: stored.objective ?? undefined,
  progress: stored.progress ?? undefined,
  processedTokens: stored.processedTokens ?? undefined,
  viewedAt: stored.viewedAt ?? undefined,
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

/**
 * What is blocking an agent, reduced to the one fact a refusal names.
 *
 * A prompt sent to a blocked agent queues silently behind whatever it is
 * waiting on, so the control route refuses it and says what stands in the
 * way. An approval outranks a question when both are somehow pending: it is
 * the one holding a tool call open.
 */
export type PendingBlock =
  | { kind: "approval"; tool: string }
  | { kind: "question"; question: string };

export const pendingBlockFrom = (
  approval: PendingApproval | undefined,
  question: PendingQuestion | undefined,
): PendingBlock | undefined =>
  approval !== undefined
    ? { kind: "approval", tool: approval.tool }
    : question !== undefined
      ? { kind: "question", question: question.question }
      : undefined;

/** Why the deck believes what it believes about one session. */
export interface AgentExplanation {
  identity: { source: "session.registered" | "heartbeat"; confidence: "registered" | "reported" };
  state: {
    /** Who the current state comes from: a claim holder, the event log, or the heartbeat. */
    source: string;
    confidence: "claimed" | "projected" | "reported";
    authority?: StateAuthority;
  };
  projectionSequence?: number;
}

/**
 * Provenance for a derived session, stated instead of guessed at.
 *
 * Debugging a multi-adapter deck starts with "why does the deck say this" —
 * whose claim is being honoured, whether identity came from the runtime
 * registering itself or only ever rode a heartbeat, and whether state is the
 * folded event log or the legacy document. This answers that in one read,
 * with a confidence word per fact rather than a judgement call per debugger.
 */
/**
 * When an event goes on the record.
 *
 * A sender may say when something happened — an adapter replaying a
 * transcript, a seeder laying out a conversation with real shape — and the
 * deck takes its word up to one limit: not the future. A skewed clock that
 * could stamp tomorrow would sort above every real event and stay pinned
 * there, taking the unseen marker and the newest-message divider with it.
 * Anything unparseable, or ahead of us, is treated as arriving now, which is
 * what an unsaid time has always meant.
 */
export const eventTime = (supplied: string | null | undefined, arrival: string): string => {
  if (supplied == null) return arrival;
  const stated = Date.parse(supplied);
  if (Number.isNaN(stated) || stated > Date.parse(arrival)) return arrival;
  return new Date(stated).toISOString();
};

/**
 * Whether a State Authority claim is still live.
 *
 * ADR-0002 makes a claim a time-boxed lease: the holder's clock releases it
 * whether or not the holder ever says so. Both the snapshot fold and the
 * explanation asked this question with their own inline comparison; asking
 * it in one place is what keeps the two from drifting apart on a rule an
 * ADR spells out.
 */
export const authorityLive = (
  authority: StateAuthority | undefined,
  now: number,
): StateAuthority | undefined =>
  authority !== undefined && Date.parse(authority.expiresAt) > now ? authority : undefined;

/**
 * How long a session may say nothing before the deck calls it offline.
 *
 * An idle session legitimately goes quiet — nobody is asking it anything —
 * so it is given minutes; a session that claimed to be working owes a
 * heartbeat far sooner, and silence past that is the deck no longer
 * vouching for it.
 */
export const OFFLINE_AFTER_IDLE_MS = 10 * 60_000;
export const OFFLINE_AFTER_ACTIVE_MS = 45_000;

/**
 * One agent as a device renders it: the stored record, corrected by its
 * runtime projection where one exists.
 *
 * The deck's most-read derivation — usage precedence, the offline decay,
 * whose identity wins, whether a claim still stands — used to live as an
 * anonymous closure inside `snapshot`, where only its two smallest slices
 * had been pulled out as pure functions and were, not coincidentally, the
 * only parts with tests. It is a function now, so the precedence questions
 * that keep arriving can be answered against a table of cases rather than a
 * running bridge.
 */
export const renderSnapshotAgent = (
  agent: AgentRecord,
  projection: RuntimeProjection | undefined,
  pending: { approval?: PendingApproval; question?: PendingQuestion },
  now: number,
): SnapshotAgent => {
  /**
   * The projection is believed, not checked against the heartbeat.
   *
   * It used to be discarded wholesale unless its state already matched the
   * stored document, which made it incapable of ever correcting one — an
   * adapter could publish a perfectly ordered event and see nothing change.
   * Measured across this bridge, that gate was also throwing away the better
   * number: heartbeats reported 0 tokens for sessions whose projection had
   * counted 220,100. The heartbeat still supplies identity and liveness,
   * which is what ADR-0001 keeps it for until every runtime registers itself.
   */
  const active = agent.runtimeProtocol === "canonical-v1" ? projection : undefined;
  const finite = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? value : fallback;
  const projectedState = active?.state ?? agent.state;
  const silence = now - Date.parse(agent.lastSeenAt);
  const grace = projectedState === "idle" ? OFFLINE_AFTER_IDLE_MS : OFFLINE_AFTER_ACTIVE_MS;
  // Sanitised once, so the fallback chain cannot end on the value it was
  // guarding against: a heartbeat reporting NaN for both figures used to put
  // NaN in the snapshot, which reaches a card as null.
  const contextTokens = active?.usageKnown ? active.contextTokens : finite(agent.tokens, 0);
  const item: SnapshotAgent = {
    ...agent,
    tokens: contextTokens,
    processedTokens: active?.usageKnown
      ? active.processedTokens
      : finite(agent.processedTokens, contextTokens),
    costUsd: finite(agent.costUsd, 0),
    // A demo session is never called offline: nothing is heartbeating it.
    state: !agent.isDemo && silence > grace ? ("offline" as const) : projectedState,
    rateLimits: snapshotRateLimits(active, agent.rateLimits),
    pendingApproval: pending.approval,
    pendingQuestion: pending.question,
    events: agent.events.slice(-SNAPSHOT_EVENT_LIMIT).reverse().map(cardEvent),
  };
  if (active) {
    item.projectionSequence = active.sequence;
    // Retained as a migration signal: it now reports whether the two agree,
    // rather than deciding whether to listen.
    item.projectionParity = active.state === agent.state;
    item.task = active.task;
    // Provenance for a derived state: a surface (or a person debugging one)
    // can see whose claim the deck is honouring instead of guessing why a
    // report did not land.
    const authority = authorityLive(active.stateAuthority, now);
    if (authority) item.stateAuthority = authority;
    if (active.identity) {
      item.name = active.identity.name;
      item.project = active.identity.project;
      item.model = active.identity.model;
      if (active.identity.capabilities) item.capabilities = active.identity.capabilities;
    }
  }
  return item;
};

export const explainAgent = (
  agent: Pick<AgentRecord, "runtimeProtocol">,
  projection: RuntimeProjection | undefined,
  now: number,
): AgentExplanation => {
  const authority = authorityLive(projection?.stateAuthority, now);
  const explanation: AgentExplanation = {
    identity:
      projection?.identity !== undefined
        ? { source: "session.registered", confidence: "registered" }
        : { source: "heartbeat", confidence: "reported" },
    state:
      authority !== undefined
        ? { source: authority.source, confidence: "claimed", authority }
        : agent.runtimeProtocol === "canonical-v1" && projection !== undefined
          ? { source: "runtime-events", confidence: "projected" }
          : { source: "heartbeat", confidence: "reported" },
  };
  if (projection !== undefined) explanation.projectionSequence = projection.sequence;
  return explanation;
};

/**
 * Rate limits as the snapshot renders them: what the runtime's own events
 * reported when they have said anything, otherwise what the heartbeat
 * carried — the same precedence identity and usage already follow for
 * canonical-v1 agents.
 */
export const snapshotRateLimits = (
  projection: Pick<RuntimeProjection, "rateLimits"> | undefined,
  heartbeat: ReadonlyArray<RateLimitWindow> | undefined,
): ReadonlyArray<RateLimitWindow> | undefined => projection?.rateLimits ?? heartbeat;

/**
 * One agent as the snapshot renders it: the stored record, corrected by its
 * runtime projection where one exists, with the live window trimmed to what a
 * card shows.
 */
export interface SnapshotAgent extends Omit<AgentRecord, "capabilities" | "events"> {
  capabilities?: ReadonlyArray<string>;
  projectionSequence?: number;
  projectionParity?: boolean;
  /** Who currently owns this session's state reports, when a claim is live. */
  stateAuthority?: StateAuthority;
  pendingQuestion?: PendingQuestion;
  events: Array<AgentEvent>;
}

/** The full document a device receives on connect and re-derives on change. */
export interface BridgeSnapshot {
  sequence: number;
  bridge: { status: string; name: string; timestamp: string };
  summary: { active: number; waiting: number; errors: number; tokens: number; costUsd: number };
  agents: Array<SnapshotAgent>;
}

export class BridgeState extends Context.Service<
  BridgeState,
  {
    readonly revision: SubscriptionRef.SubscriptionRef<number>;
    readonly snapshot: Effect.Effect<BridgeSnapshot>;
    readonly heartbeat: (input: Heartbeat) => Effect.Effect<AgentRecord>;
    readonly addEvent: (
      agentId: string,
      event: AgentEventInput,
    ) => Effect.Effect<AgentEvent | undefined>;
    readonly ingestRuntimeEvent: (
      value: JsonValue | CanonicalRuntimeEvent,
    ) => Effect.Effect<
      { sequence: number; event: CanonicalRuntimeEvent } | { accepted: false; reason: "stale" },
      InvalidRuntimeEvent
    >;
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
    readonly pendingBlock: (agentId: string) => Effect.Effect<PendingBlock | undefined>;
    readonly pendingCommands: (
      agentId: string,
      after?: string,
      waitMs?: number,
    ) => Effect.Effect<ReadonlyArray<Command>>;
    readonly acknowledge: (
      agentId: string,
      commandId: string,
    ) => Effect.Effect<Command | undefined>;
    readonly markViewed: (agentId: string) => Effect.Effect<string | undefined>;
    readonly removeAgent: (agentId: string) => Effect.Effect<boolean>;
    readonly requestStatus: (
      agentId: string,
      requestId: string,
      waitMs?: number,
    ) => Effect.Effect<{ status: RuntimeRequestStatus; value?: JsonValue } | undefined>;
    readonly resolveRuntimeRequest: (
      agentId: string,
      requestId: string,
      status: RuntimeRequestStatus,
      value?: JsonValue,
    ) => Effect.Effect<boolean>;
    readonly explain: (agentId: string) => Effect.Effect<AgentExplanation | undefined>;
    /** The one owner of durable Requests; see RequestLedger. */
    readonly requests: RequestLedger;
    readonly setSlashCommands: (
      agentId: string,
      commands: ReadonlyArray<JsonValue>,
    ) => Effect.Effect<void>;
    readonly commandReceipt: (commandId: string) => Effect.Effect<CommandReceiptRow | undefined>;
    /** The message commands still waiting to be collected, oldest first. */
    readonly queuedMessages: (agentId: string) => Effect.Effect<ReadonlyArray<Command>>;
    /**
     * Withdraws a queued command before the runtime collects it. False once
     * the runtime has acknowledged it — a delivered instruction cannot be
     * unsaid, only followed up.
     */
    readonly cancelCommand: (agentId: string, commandId: string) => Effect.Effect<boolean>;
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
    readonly revokeDeviceById: (id: string) => Effect.Effect<boolean>;
    /** The devices holding a live credential, newest activity first. */
    readonly devices: Effect.Effect<ReadonlyArray<PairedDevice>>;
    readonly createPairingCode: Effect.Effect<{ code: string; expiresAt: string }>;
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

      /**
       * Bumping the revision is what wakes every SSE subscriber, and a woken
       * subscriber immediately re-reads `agentsRef` to diff what it sends. So
       * every mutation must land in `agentsRef` before it runs `changed`: bump
       * first and the subscriber can diff against the stale map, conclude
       * nothing moved, and silently drop that update for that device.
       */
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

      const persistSessionEvent = (agentId: string, event: AgentEvent) =>
        sql`INSERT INTO bridge_session_events (id, agent_id, kind, summary, detail, tool, command, path, options, subagent_id, subagent_type, subagent_name, turn_id, created_at)
            VALUES (${event.id}, ${agentId}, ${event.kind}, ${event.summary}, ${event.detail ?? null},
                    ${event.tool ?? null}, ${event.command ?? null}, ${event.path ?? null},
                    ${event.options?.length ? JSON.stringify(event.options) : null},
                    ${event.subagentId ?? null}, ${event.subagentType ?? null}, ${event.subagentName ?? null},
                    ${event.turnId ?? null}, ${event.createdAt})
            ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, summary = excluded.summary, detail = excluded.detail,
              tool = excluded.tool, command = excluded.command, path = excluded.path, options = excluded.options,
              subagent_id = excluded.subagent_id, subagent_type = excluded.subagent_type,
              subagent_name = excluded.subagent_name, turn_id = excluded.turn_id`.pipe(
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
        usage.recordActivity(agent, event);

      /**
       * The durable ordered log and its folded projections — ADR-0001's core,
       * owned by one module; see RuntimeEventLog.
       */
      const log = makeRuntimeEventLog({ sql, now });

      /**
       * What the deck has spent and what it has done. ADR-0001's separation
       * of Processed from Context usage is that module's to keep; it used to
       * be kept by twenty lines sitting in the middle of `heartbeat`.
       */
      const usage = makeUsageLedger({ sql, now }, yield* emptyTranscriptCache());

      /**
       * The Request lifecycle in one place. The ledger publishes each
       * resolution it settles — expiry included — through the same event log
       * as any other fact, and announces the change.
       */
      const requests: RequestLedger = makeRequestLedger({
        sql,
        now,
        recordResolution: (agentId, eventType, requestId, payload) =>
          log
            .record(agentId, eventType, payload, {
              requestId,
              id: `request-resolved:${requestId}`,
            })
            .pipe(Effect.asVoid),
        changed,
      });

      /**
       * The one owner of queued Commands and their receipts. Built here for
       * the same reason the ledger is: it publishes delivery facts through the
       * event log and announces changes, and both live in this closure.
       */
      const queue = makeCommandQueue(
        {
          sql,
          now,
          recordDelivery: (agentId, commandId) =>
            log.record(agentId, "session.state.changed", {
              commandId,
              delivery: "acknowledged",
            }),
          changed,
        },
        commandsRef,
      );

      const syncApprovalRequest = Effect.fn("BridgeState.syncApprovalRequest")(function* (
        agent: AgentRecord,
        previous?: AgentRecord,
      ) {
        if (agent.pendingApproval) {
          yield* requests.open(
            agent.id,
            agent.pendingApproval.id,
            "approval",
            agent.pendingApproval,
            agent.pendingApproval.createdAt,
            agent.pendingApproval.expiresAt,
          );
          if (
            previous?.pendingApproval &&
            previous.pendingApproval.id !== agent.pendingApproval.id
          ) {
            yield* requests.setStatus(previous.pendingApproval.id, "unavailable");
          }
        } else if (previous?.pendingApproval) {
          yield* requests.setStatus(
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
        const projections = yield* log.projections();
        const { approvals, questions } = yield* requests.pendingByAgent();
        const rendered = [...agents.values()].map((agent) =>
          renderSnapshotAgent(
            agent,
            projections.get(agent.id),
            {
              approval: approvals.get(agent.id),
              question: questions.get(agent.id),
            },
            timestamp,
          ),
        );
        const historical = yield* usage.total();
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
          // A later heartbeat may omit it; where the session works does not
          // change because a beat left the field out.
          cwd: input.cwd ?? previous?.cwd,
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
          // Seen belongs to the viewer, not the runtime: a heartbeat rebuilds
          // the record from the wire, and must not wipe what a person did.
          viewedAt: previous?.viewedAt,
          events: mergeRecentEvents(previous?.events ?? [], [...(input.events ?? [])]),
          capabilities: input.capabilities ? [...input.capabilities] : undefined,
          rateLimits: input.rateLimits ?? undefined,
          pendingApproval: input.pendingApproval ?? undefined,
        };
        yield* persistAgent(agent);
        yield* syncApprovalRequest(agent, previous);
        yield* usage.record(agent);
        if (
          agent.runtimeProtocol !== "canonical-v1" &&
          (!previous ||
            previous.state !== agent.state ||
            previous.task !== agent.task ||
            previous.objective !== agent.objective)
        ) {
          yield* log.record(agent.id, "session.state.changed", {
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
          yield* log.record(
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
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agent.id, agent));
        yield* changed;
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
          createdAt: eventTime(existing?.createdAt ?? event.createdAt, now()),
        };
        const events = [...previous.events];
        if (existingIndex >= 0) events[existingIndex] = created;
        else events.push(created);
        // A stated time can land behind what is already here, and every reader
        // downstream — day separators, silence gaps, the unseen divider —
        // takes this array's order as the order things happened. The sort is
        // stable, so events arriving live with the same stamp keep the order
        // they arrived in.
        // Every stamp is canonical ISO 8601 (`eventTime` normalises the ones
        // that come in), so comparing them as text is comparing them as time.
        events.sort((left, right) =>
          left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
        );
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
          yield* log.record(
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
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agentId, agent));
        yield* changed;
        return created;
      });

      /**
       * The last state-report sequence accepted per agent and origin source.
       * In memory only: a restart forgets it, and the first report after a
       * restart is accepted regardless, which is the safe direction to fail.
       */

      const ingestRuntimeEvent = Effect.fn("BridgeState.ingestRuntimeEvent")(function* (
        value: JsonValue | CanonicalRuntimeEvent,
      ) {
        const event = yield* Effect.try({
          try: () => canonicalRuntimeEvent(value),
          catch: (cause) =>
            new InvalidRuntimeEvent({
              reason: cause instanceof Error ? cause.message : "Invalid runtime event",
            }),
        });
        const outcome = yield* log.ingest(event);
        if (outcome.accepted === false) return { accepted: false, reason: outcome.reason } as const;
        const sequence = outcome.sequence;
        // A request's kind comes from the event type, never the payload: the
        // two lifecycles resolve through different endpoints.
        if (event.type === "request.opened" || event.type === "user-input.requested") {
          if (!event.requestId) {
            return yield* new InvalidRuntimeEvent({
              reason: "Request lifecycle events require requestId",
            });
          }
          const kind = event.type === "request.opened" ? "approval" : "user-input";
          const expiresAt = Option.getOrUndefined(decodeString(event.payload.expiresAt));
          yield* requests.open(
            event.agentId,
            event.requestId,
            kind,
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
          const reported = Option.getOrUndefined(decodeString(event.payload.status));
          // SAFETY: a runtime that reports a status reports one of the
          // canonical request statuses; the deployed bridge trusted this
          // rather than validating, and rejecting here would drop the event.
          const status =
            reported !== undefined
              ? (reported as RuntimeRequestStatus)
              : event.type === "user-input.resolved"
                ? "answered"
                : "unavailable";
          yield* requests.setStatus(event.requestId, status);
        }
        yield* changed;
        return { sequence, event };
      });

      const hasPendingApproval = (agentId: string) =>
        Effect.map(requests.pendingFor(agentId), (pending) => pending.approval != null);

      /** What the agent is blocked on right now, or undefined when it is free. */
      const pendingBlock = Effect.fn("BridgeState.pendingBlock")(function* (agentId: string) {
        // Both kinds are read even when the first answers, so an expired
        // question gets settled here the same way the snapshot would settle it.
        const pending = yield* requests.pendingFor(agentId);
        return pendingBlockFrom(pending.approval, pending.question);
      });

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
        // A retried command must not queue a second action.
        const retried = yield* queue.existing(commandId);
        if (retried) return retried;
        if (
          (action === "approve" || action === "reject") &&
          !(yield* hasPendingApproval(agentId))
        ) {
          return undefined;
        }
        const command = yield* queue.queue({
          id: commandId ?? makeId(),
          agentId,
          action,
          value,
          createdAt: now(),
        });

        const agent: AgentRecord = { ...existing, events: [...existing.events] };
        if (action === "pause") agent.state = "paused";
        if (action === "resume") agent.state = "running";
        if (action === "stop") agent.state = "idle";
        if (action === "approve" || action === "reject") {
          const request = (yield* requests.pendingFor(agentId)).approval;
          if (request) {
            yield* requests.resolve(
              agentId,
              request.id,
              action === "approve" ? "approved" : "rejected",
            );
          }
          agent.state = "running";
          agent.pendingApproval = undefined;
        }
        if (isMessageAction(action) && value) {
          agent.task = value;
          agent.state = "running";
        }
        agent.events.push({
          id: makeId(),
          kind: isMessageAction(action) ? "user" : "output",
          summary: `Remote command: ${action}`,
          // A model id is not something a person said. Carrying it as the
          // event's detail put "sonnet" in the conversation as the reader's
          // own words; the summary already names what happened.
          detail: action === "set_model" ? undefined : value,
          createdAt: now(),
        });
        yield* persistAgent(agent);
        yield* log.record(agentId, "session.state.changed", {
          state: agent.state,
          commandId: command.id,
          action,
        });
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agentId, agent));
        yield* changed;
        return command;
      });

      /**
       * One deck change, however long it takes — the primitive behind the
       * routes' `wait`. Woken by the same revision bump that wakes the SSE
       * stream, so a parked caller costs nothing between changes.
       */
      const nextChange = SubscriptionRef.changes(revision).pipe(
        // `changes` replays the current value before any change; the park is
        // for the change after it.
        Stream.drop(1),
        Stream.take(1),
        Stream.runDrain,
      );

      /**
       * A semantic wait: re-asks `look` after every deck change until the
       * answer settles or the deadline passes, then answers with whatever
       * stands. Adapters used to ask these questions once a second for up to
       * ten minutes; parked here, the answer arrives on the change that
       * settles it and an unsettled wait costs one read per change.
       */
      const awaitSettled = <A>(
        waitMs: number,
        look: Effect.Effect<A>,
        settled: (value: A) => boolean,
      ) =>
        Effect.gen(function* () {
          const deadline = Date.now() + waitMs;
          for (;;) {
            const value = yield* look;
            if (settled(value)) return value;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return value;
            yield* Effect.race(nextChange, Effect.sleep(Duration.millis(remaining)));
          }
        });

      const pendingCommandsNow = queue.pendingFor;

      const pendingCommands = (agentId: string, after?: string, waitMs = 0) =>
        awaitSettled(waitMs, pendingCommandsNow(agentId, after), (queued) => queued.length > 0);

      const queuedMessages = queue.queuedMessages;

      const cancelCommand = queue.cancel;

      const acknowledge = queue.acknowledge;

      const removeAgent = Effect.fn("BridgeState.removeAgent")(function* (agentId: string) {
        const agents = yield* Ref.get(agentsRef);
        if (!agents.has(agentId)) return false;
        // The live map first, the row second: the next patch's `removed` list
        // is computed from the map, and the row only decides what a restart
        // resurrects. History, usage, and file changes are deliberately kept —
        // dismissing a dead session is decluttering the deck, not erasing what
        // the session did.
        yield* Ref.update(agentsRef, (map) => {
          const next = new Map(map);
          next.delete(agentId);
          return next;
        });
        yield* sql`DELETE FROM bridge_agents WHERE id = ${agentId}`.pipe(Effect.orDie);
        yield* changed;
        return true;
      });

      const markViewed = Effect.fn("BridgeState.markViewed")(function* (agentId: string) {
        const agents = yield* Ref.get(agentsRef);
        const existing = agents.get(agentId);
        if (existing === undefined) return undefined;
        const agent: AgentRecord = { ...existing, viewedAt: now() };
        yield* Ref.update(agentsRef, (map) => new Map(map).set(agentId, agent));
        yield* persistAgent(agent);
        yield* changed;
        return agent.viewedAt;
      });

      const requestStatus = (agentId: string, requestId: string, waitMs = 0) =>
        awaitSettled(
          waitMs,
          requests.status(requestId, agentId),
          (standing) => standing === undefined || standing.status !== "pending",
        );

      const resolveRuntimeRequest = requests.resolve;

      const explain = Effect.fn("BridgeState.explain")(function* (agentId: string) {
        const agent = (yield* Ref.get(agentsRef)).get(agentId);
        if (agent === undefined) return undefined;
        const stored = yield* log.projection(agentId);
        return explainAgent(agent, stored?.projection, Date.now());
      });

      const setSlashCommands = Effect.fn("BridgeState.setSlashCommands")(
        function* (agentId: string, commands: ReadonlyArray<JsonValue>) {
          yield* sql`INSERT INTO bridge_slash_commands (agent_id, commands, updated_at)
                   VALUES (${agentId}, ${JSON.stringify(commands ?? [])}, ${now()})
                   ON CONFLICT(agent_id) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at`;
        },
        Effect.orDie,
        Effect.asVoid,
      );

      const commandReceipt = queue.receipt;

      const analytics = Effect.fn("BridgeState.analytics")(function* (
        range: string,
        project?: string,
        timeZone = "UTC",
      ) {
        const generatedAt = now();
        const { cutoff } = rangeCutoff(range, Date.parse(generatedAt));
        const { usage: ledgerUsage, activity: activityRows } = yield* usage.since(cutoff);
        const transcript = yield* usage.transcripts(cutoff);
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
            rateLimits: agent.rateLimits,
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
          const stored = yield* log.projection(agent.id);
          const projection = stored?.projection;
          out.push({
            agentId: agent.id,
            runtime: runtimeFor(agent),
            projectionSequence: stored?.sequence ?? null,
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

      /**
       * The one owner of paired devices and the codes that mint them. Built
       * here so the failure counter lives as long as the bridge does: a
       * lockout that reset on every call would not be one.
       */
      const devices = makeDeviceRegistry({ sql, now }, yield* Ref.make(0));
      const pair = devices.pair;
      const revokeDevice = devices.revokeByToken;
      const revokeDeviceById = devices.revokeById;
      const createPairingCode = devices.issueCode();
      const deviceList = devices.list();

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
        pendingBlock,
        pendingCommands,
        acknowledge,
        removeAgent,
        markViewed,
        requestStatus,
        resolveRuntimeRequest,
        explain,
        requests,
        setSlashCommands,
        commandReceipt,
        queuedMessages,
        cancelCommand,
        analytics,
        projectionParity,
        pair,
        revokeDevice,
        revokeDeviceById,
        devices: deviceList,
        createPairingCode,
      });
    }),
  );
}
