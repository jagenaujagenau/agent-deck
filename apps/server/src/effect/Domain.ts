import { Schema } from "effect";

/**
 * The wire contract the phone, watch, hooks, and adapters already speak.
 *
 * These schemas describe an interface that is already deployed on devices, so
 * they are written to match it exactly rather than to be tidy. Optional fields
 * stay optional for that reason: an adapter that omits `tool` is valid, and
 * tightening it here would reject traffic the current bridge accepts.
 */

/**
 * A field a runtime may leave out entirely, or send as an explicit null.
 *
 * The adapters are separate programs written at different times and are not
 * consistent about which they do. The deployed bridge treats both as absent,
 * so accepting only the omitted form here would refuse heartbeats that work
 * today - and a refused heartbeat shows up as a session going offline.
 */
const optionalField = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

/**
 * A parsed JSON document, as JSON.parse produces one.
 *
 * The bridge stores several blobs it wrote with JSON.stringify and reads back
 * with JSON.parse - stored agents, request payloads, resolution values. Naming
 * what such a value can be lets those reads carry a real contract instead of
 * `unknown`, without pretending to know a shape the wire deliberately leaves
 * open.
 */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

const EventKind = Schema.Literals([
  "thought",
  "tool",
  "output",
  "warning",
  "error",
  "question",
  "user",
]);
type EventKind = typeof EventKind.Type;

export const AgentEvent = Schema.Struct({
  id: Schema.String,
  kind: EventKind,
  summary: Schema.String,
  detail: optionalField(Schema.String),
  tool: optionalField(Schema.String),
  path: optionalField(Schema.String),
  command: optionalField(Schema.String),
  diff: optionalField(Schema.String),
  options: optionalField(Schema.Array(Schema.String)),
  /**
   * Which subagent did this, where one did.
   *
   * Claude Code tags every tool hook made inside a subagent with its own id and
   * type. The adapter used to drop both, so a subagent's work arrived in the
   * parent's stream indistinguishable from the parent's own - which is exactly
   * what made a session running three of them unreadable.
   */
  subagentId: optionalField(Schema.String),
  subagentType: optionalField(Schema.String),
  /**
   * What the run was asked to do — the Task call's own wording, "Fix lint in
   * apps/server". The type says what kind of agent ran; this says why. A
   * surface titles the run with it when present, because five parallel
   * "general-purpose" runs are indistinguishable by type alone.
   */
  subagentName: optionalField(Schema.String),
  /**
   * Which exchange this belongs to. A turn is the deck's thread unit — one
   * instruction and everything done in its service — and without the id a
   * client can only guess the grouping from timestamps.
   */
  turnId: optionalField(Schema.String),
  createdAt: Schema.String,
});
export interface AgentEvent extends Schema.Schema.Type<typeof AgentEvent> {}

/** What a runtime posts to `/agents/:id/events`; the bridge assigns id and time. */
export const AgentEventInput = Schema.Struct({
  id: optionalField(Schema.String),
  kind: EventKind,
  summary: Schema.String,
  detail: optionalField(Schema.String),
  tool: optionalField(Schema.String),
  path: optionalField(Schema.String),
  command: optionalField(Schema.String),
  diff: optionalField(Schema.String),
  options: optionalField(Schema.Array(Schema.String)),
  subagentId: optionalField(Schema.String),
  subagentType: optionalField(Schema.String),
  subagentName: optionalField(Schema.String),
  turnId: optionalField(Schema.String),
});
export interface AgentEventInput extends Schema.Schema.Type<typeof AgentEventInput> {}

export const AgentState = Schema.Literals([
  "idle",
  "running",
  "waiting",
  "paused",
  "error",
  "offline",
]);
export type AgentState = typeof AgentState.Type;

export const ControlAction = Schema.Literals([
  "pause",
  "resume",
  "stop",
  "approve",
  "reject",
  "prompt",
  "steer",
  "follow_up",
]);
export type ControlAction = typeof ControlAction.Type;

export const PendingApproval = Schema.Struct({
  id: Schema.String,
  tool: Schema.String,
  detail: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export interface PendingApproval extends Schema.Schema.Type<typeof PendingApproval> {}

export const RateLimitWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: optionalField(Schema.String),
  account: optionalField(Schema.String),
});
export interface RateLimitWindow extends Schema.Schema.Type<typeof RateLimitWindow> {}

/** The heartbeat body a runtime adapter sends to keep its session live. */
export const Heartbeat = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  /** The directory the session works in, on the bridge's machine. */
  cwd: optionalField(Schema.String),
  model: Schema.String,
  runtime: optionalField(Schema.String),
  runtimeProtocol: optionalField(Schema.Literals(["canonical-v1"])),
  state: AgentState,
  task: Schema.String,
  objective: optionalField(Schema.String),
  progress: optionalField(Schema.Number),
  tokens: optionalField(Schema.Number),
  processedTokens: optionalField(Schema.Number),
  costUsd: optionalField(Schema.Number),
  capabilities: optionalField(Schema.Array(ControlAction)),
  rateLimits: optionalField(Schema.Array(RateLimitWindow)),
  pendingApproval: optionalField(PendingApproval),
  events: optionalField(Schema.Array(AgentEvent)),
});
export interface Heartbeat extends Schema.Schema.Type<typeof Heartbeat> {}

/** Body for steering an agent or resolving what it is blocked on. */
export const ControlCommand = Schema.Struct({
  action: ControlAction,
  value: optionalField(Schema.String),
  commandId: optionalField(Schema.String),
  /**
   * Queue a prompt even while the agent is blocked on an approval or a
   * question. Without it, the bridge refuses such a prompt outright — text
   * that silently queues behind a pending request reads as steering that
   * never happened. Deliberate "queue anyway" is what this flag says.
   */
  force: optionalField(Schema.Boolean),
});

/**
 * The statuses a caller may resolve a request to. "pending" is deliberately
 * absent: reopening a settled request is not something the wire allows.
 */
const ResolvableStatus = Schema.Literals([
  "approved",
  "rejected",
  "answered",
  "expired",
  "unavailable",
]);

/** Body for resolving a durable approval or question. */
export const ResolveRequestBody = Schema.Struct({
  status: ResolvableStatus,
  value: optionalField(Schema.Unknown),
});

/**
 * A published command catalog. The entries stay unconstrained on purpose: each
 * runtime describes its own commands, and the deployed bridge stores whatever
 * array it is handed rather than imposing a shape on them.
 */
export const SlashCommandPublication = Schema.Struct({
  commands: Schema.Array(Schema.Unknown),
});

/**
 * The part of a start request that must be there at all.
 *
 * Kept separate so a rejected body can say which thing was wrong: a missing
 * project and an unrecognised permission mode are different mistakes, and one
 * message for both sends the caller looking in the wrong place.
 */
export const ManagedSessionTarget = Schema.Struct({
  project: Schema.String,
  cwd: Schema.String,
});

/** Body for starting a bridge-hosted Claude session. */
export const ManagedSessionRequest = Schema.Struct({
  project: Schema.String,
  cwd: Schema.String,
  model: optionalField(Schema.String),
  objective: optionalField(Schema.String),
  prompt: optionalField(Schema.String),
  permissionMode: optionalField(
    Schema.Literals(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]),
  ),
});

/** Body for exchanging a pairing code for a device credential. */
export const PairingRequest = Schema.Struct({
  code: Schema.String,
  deviceName: Schema.String,
});

/** Only the routing field is read here; the event itself is validated downstream. */
export const RuntimeEventEnvelope = Schema.Struct({
  agentId: Schema.String,
});

/**
 * An agent as it is stored, which is not quite an agent as it arrives.
 *
 * The row was written by whichever build of the bridge was running at the
 * time, so it is decoded rather than trusted: a blob that no longer fits is
 * one session missing from the deck, not a bridge that fails to start.
 */
export const StoredAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  cwd: optionalField(Schema.String),
  model: Schema.String,
  runtime: optionalField(Schema.String),
  runtimeProtocol: optionalField(Schema.Literals(["canonical-v1"])),
  state: AgentState,
  task: Schema.String,
  objective: optionalField(Schema.String),
  progress: optionalField(Schema.Number),
  tokens: Schema.Number,
  processedTokens: optionalField(Schema.Number),
  costUsd: Schema.Number,
  lastSeenAt: Schema.String,
  viewedAt: optionalField(Schema.String),
  events: Schema.Array(AgentEvent),
  capabilities: optionalField(Schema.Array(ControlAction)),
  rateLimits: optionalField(Schema.Array(RateLimitWindow)),
  pendingApproval: optionalField(PendingApproval),
  isDemo: optionalField(Schema.Boolean),
});

/** A queued control command as it is stored. */
export const StoredCommand = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  action: ControlAction,
  value: optionalField(Schema.String),
  createdAt: Schema.String,
  acknowledgedAt: optionalField(Schema.String),
});
