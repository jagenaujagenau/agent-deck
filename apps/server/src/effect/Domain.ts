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

export const EventKind = Schema.Literals([
  "thought",
  "tool",
  "output",
  "warning",
  "error",
  "question",
  "user",
]);
export type EventKind = typeof EventKind.Type;

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

export const RequestStatus = Schema.Literals([
  "pending",
  "approved",
  "rejected",
  "answered",
  "expired",
  "unavailable",
]);
export type RequestStatus = typeof RequestStatus.Type;

/** Body for resolving a durable approval or question. */
export const ResolveRequest = Schema.Struct({
  status: RequestStatus,
  value: optionalField(Schema.Unknown),
});

export const ControlCommand = Schema.Struct({
  action: ControlAction,
  value: optionalField(Schema.String),
  commandId: optionalField(Schema.String),
});

export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: optionalField(Schema.String),
  source: Schema.String,
});

/**
 * The statuses a caller may resolve a request to. "pending" is deliberately
 * absent: reopening a settled request is not something the wire allows.
 */
export const ResolvableStatus = Schema.Literals([
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

export const SlashCommandCatalog = Schema.Struct({
  commands: Schema.Array(SlashCommand),
});
