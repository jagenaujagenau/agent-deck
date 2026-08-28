/**
 * The wire, as `docs/bridge-api.md` states it.
 *
 * These are the shapes a consumer reads; the adapter-side inputs (heartbeats,
 * runtime events) live in `@agent-control-dashboard/agent-adapter`. Optional
 * fields are optional on the wire — a bridge may omit them, and an older
 * bridge will.
 */

export type AgentState = "idle" | "running" | "waiting" | "paused" | "error" | "offline";

export type AgentEventKind =
  | "thought"
  | "tool"
  | "output"
  | "warning"
  | "error"
  | "question"
  | "user";

export type ControlAction =
  | "pause"
  | "resume"
  | "stop"
  | "approve"
  | "reject"
  | "prompt"
  | "steer"
  | "follow_up";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  summary: string;
  detail?: string;
  createdAt: string;
  tool?: string;
  path?: string;
  command?: string;
  diff?: string;
  options?: ReadonlyArray<string>;
  /** Whose work this is, where a subagent did it. Absent on the parent's own. */
  subagentId?: string;
  subagentType?: string;
  /** What the run was asked to do — the delegating call's own wording. */
  subagentName?: string;
  /** Which exchange this belongs to — the deck's thread unit. */
  turnId?: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  detail: string;
  createdAt: string;
  expiresAt: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options?: ReadonlyArray<string>;
  createdAt: string;
  expiresAt: string;
}

export interface RateLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  account?: string;
  runtime?: string;
}

export interface Agent {
  id: string;
  name: string;
  project: string;
  /** The directory the session works in, on the bridge's machine. */
  cwd?: string;
  model: string;
  state: AgentState;
  task: string;
  objective?: string;
  progress?: number;
  tokens: number;
  processedTokens?: number;
  costUsd: number;
  lastSeenAt: string;
  /** The last moment a person looked at this session, on any surface. */
  viewedAt?: string;
  /** The adapter's own word for its harness — "claude", "codex", "opencode", "pi". */
  runtime?: string;
  /** A rolling window of the newest events, newest first, trimmed for cards. */
  events: ReadonlyArray<AgentEvent>;
  capabilities?: ReadonlyArray<ControlAction>;
  rateLimits?: ReadonlyArray<RateLimitWindow>;
  pendingApproval?: PendingApproval;
  pendingQuestion?: PendingQuestion;
}

export interface BridgeInfo {
  status: string;
  name: string;
  timestamp: string;
}

export interface DeckSummary {
  active: number;
  waiting: number;
  errors: number;
  tokens: number;
  costUsd: number;
}

export interface BridgeSnapshot {
  sequence: number;
  bridge: BridgeInfo;
  summary: DeckSummary;
  agents: ReadonlyArray<Agent>;
}

/**
 * An incremental stream update: the agents whose rendered state changed, plus
 * any that are gone. Everything absent is unchanged and must be carried over.
 */
export interface BridgeSnapshotPatch {
  sequence: number;
  bridge: BridgeInfo;
  summary: DeckSummary;
  agents: ReadonlyArray<Agent>;
  removed: ReadonlyArray<string>;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

export interface CommandReceipt {
  commandId: string;
  status: string;
  error?: string;
  resultSequence?: number;
  updatedAt: string;
}

export interface QueuedCommand {
  id: string;
  agentId: string;
  action: ControlAction;
  value?: string;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface PairedDevice {
  id: string;
  token: string;
  name: string;
  createdAt: string;
}

export interface ManagedRuntime {
  runtime: string;
  managed: boolean;
  capabilities?: Record<string, boolean>;
}
