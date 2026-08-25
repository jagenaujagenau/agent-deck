import { Schema } from "effect";

/**
 * The wire contract the phone, watch, hooks, and adapters already speak.
 *
 * These schemas describe an interface that is already deployed on devices, so
 * they are written to match it exactly rather than to be tidy. Optional fields
 * stay optional for that reason: an adapter that omits `tool` is valid, and
 * tightening it here would reject traffic the current bridge accepts.
 */

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
  detail: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  diff: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  createdAt: Schema.String,
});
export interface AgentEvent extends Schema.Schema.Type<typeof AgentEvent> {}

/** What a runtime posts to `/agents/:id/events`; the bridge assigns id and time. */
export const AgentEventInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  kind: EventKind,
  summary: Schema.String,
  detail: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  diff: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
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
  resetsAt: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
});

/** The heartbeat body a runtime adapter sends to keep its session live. */
export const Heartbeat = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  model: Schema.String,
  runtime: Schema.optional(Schema.String),
  runtimeProtocol: Schema.optional(Schema.Literals(["canonical-v1"])),
  state: AgentState,
  task: Schema.String,
  objective: Schema.optional(Schema.String),
  progress: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Number),
  processedTokens: Schema.optional(Schema.Number),
  costUsd: Schema.optional(Schema.Number),
  capabilities: Schema.optional(Schema.Array(ControlAction)),
  rateLimits: Schema.optional(Schema.Array(RateLimitWindow)),
  pendingApproval: Schema.optional(PendingApproval),
  events: Schema.optional(Schema.Array(AgentEvent)),
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
  value: Schema.optional(Schema.Unknown),
});

export const ControlCommand = Schema.Struct({
  action: ControlAction,
  value: Schema.optional(Schema.String),
  commandId: Schema.optional(Schema.String),
});

export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.String,
});

export const SlashCommandCatalog = Schema.Struct({
  commands: Schema.Array(SlashCommand),
});
