import { isJsonNumber, isJsonObject, isJsonString } from "./json-value";
import type { JsonValue } from "./json-value";
import type { CanonicalRuntimeEvent, RuntimeRequestStatus } from "./runtime-events";

/**
 * One usage window as a runtime reports it: how much of a rate-limited
 * allowance is spent, named well enough for a card to label it. This is the
 * same shape the heartbeat's `rateLimits` carries, so a snapshot can prefer
 * whichever source spoke.
 */
export type ProjectedRateLimit = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  account?: string;
};

export type RuntimeProjection = {
  agentId: string;
  sequence: number;
  /**
   * Who this session is, as the runtime declared itself.
   *
   * Absent until a `session.registered` event arrives. The heartbeat was the
   * only carrier of identity, which is the single reason it had to stay: a
   * projection that cannot say what a session is called cannot replace a
   * document that can. ADR-0001 names this as the migration's exit condition.
   */
  identity?: {
    name: string;
    project: string;
    model: string;
    runtime?: string;
    capabilities?: ReadonlyArray<string>;
  };
  state: "idle" | "running" | "waiting" | "paused" | "error" | "offline";
  task: string;
  activeTurnId?: string;
  activeItemId?: string;
  pendingRequest?: {
    id: string;
    kind: "approval" | "user-input";
    status: RuntimeRequestStatus;
    payload: CanonicalRuntimeEvent["payload"];
  };
  contextTokens: number;
  processedTokens: number;
  usageKnown: boolean;
  /** Absent until a `rate-limits.updated` event arrives; then the latest report. */
  rateLimits?: ReadonlyArray<ProjectedRateLimit>;
  /**
   * The one publisher whose state reports currently move this session, and
   * until when. Held by a state report carrying `claim: {ttlMs}`; released by
   * the holder's next report without one, or by the clock. While live, a
   * `session.state.changed` from any other source advances the fold's cursor
   * but not the state — the claim exists precisely because that other
   * publisher may be repeating something it read before the world changed.
   */
  stateAuthority?: StateAuthority;
  updatedAt: string;
};

export type StateAuthority = { source: string; expiresAt: string };

/**
 * A claim is honest only if it expires: a claimant that crashed must decay
 * back to whoever else can still see the session. Capped a day out so a
 * malformed ttl cannot park a session behind a dead claimant forever.
 */
const MAX_STATE_AUTHORITY_TTL_MS = 24 * 60 * 60_000;

export function emptyRuntimeProjection(agentId: string): RuntimeProjection {
  return {
    agentId,
    sequence: 0,
    state: "idle",
    task: "Ready",
    contextTokens: 0,
    processedTokens: 0,
    usageKnown: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export function projectRuntimeEvent(
  current: RuntimeProjection,
  event: CanonicalRuntimeEvent,
  sequence: number,
): RuntimeProjection {
  if (event.agentId !== current.agentId || sequence <= current.sequence) return current;
  const next = { ...current, sequence, updatedAt: event.createdAt };
  switch (event.type) {
    case "session.registered":
      return {
        ...next,
        identity: {
          name: text(event.payload.name) ?? current.identity?.name ?? current.agentId,
          project: text(event.payload.project) ?? current.identity?.project ?? "",
          model: text(event.payload.model) ?? current.identity?.model ?? "",
          runtime: text(event.payload.runtime) ?? current.identity?.runtime,
          // SAFETY: registration events are written by this repo's adapters,
          // which declare capabilities as an array of action names; a foreign
          // value could only mislabel controls, never break the projection.
          capabilities: Array.isArray(event.payload.capabilities)
            ? (event.payload.capabilities as ReadonlyArray<string>)
            : current.identity?.capabilities,
        },
        // Registration says who, not what it is doing. A session that
        // re-registers after a reconnect has not gone back to idle.
        state: current.sequence === 0 ? next.state : current.state,
        task: current.sequence === 0 ? next.task : current.task,
      };
    case "session.state.changed": {
      // Only state *reports* are guarded by a claim. Lifecycle events —
      // turns, items, requests — are positive evidence that something real
      // happened and always apply; a report is a publisher's opinion of where
      // the session stands, and opinions are what go stale.
      const source = event.origin?.source;
      const lease = current.stateAuthority;
      const leaseLive =
        lease !== undefined && Date.parse(lease.expiresAt) > Date.parse(event.createdAt);
      if (leaseLive && source !== lease.source) return next;
      const applied = {
        ...next,
        state: state(event.payload.state),
        task: text(event.payload.task) ?? current.task,
      };
      const ttlMs = claimTtlMs(event.payload.claim);
      if (ttlMs !== undefined && source !== undefined) {
        applied.stateAuthority = {
          source,
          expiresAt: new Date(Date.parse(event.createdAt) + ttlMs).toISOString(),
        };
      } else {
        // The holder reporting without a claim is the release; a stranger
        // landing after expiry sweeps the dead lease out with it.
        delete applied.stateAuthority;
      }
      return applied;
    }
    case "turn.started":
      return {
        ...next,
        state: "running",
        activeTurnId: event.turnId,
        task: text(event.payload.objective) ?? "Working",
      };
    case "turn.completed":
      return {
        ...next,
        state: event.payload.status === "failed" ? "error" : "idle",
        activeTurnId: undefined,
        activeItemId: undefined,
        task: text(event.payload.summary) ?? "Turn completed",
      };
    case "request.opened":
    case "user-input.requested":
      return event.requestId
        ? {
            ...next,
            state: "waiting",
            pendingRequest: {
              id: event.requestId,
              kind: event.type === "request.opened" ? "approval" : "user-input",
              status: "pending",
              payload: event.payload,
            },
          }
        : next;
    case "request.resolved":
    case "user-input.resolved": {
      const resolved = {
        ...next,
        // A settled request means the question is answered, not that the
        // session went back to work. Usually it did - the blocked call resumes -
        // but a request that expired unanswered leaves the runtime exactly where
        // it was, and saying "running" there reported sessions as busy while
        // they sat at a prompt.
        state:
          event.payload.status === "answered" || event.payload.status === "approved"
            ? "running"
            : current.state,
        pendingRequest: undefined,
      };
      // The holder resolving its request is the release: the claimed window
      // existed for that request, and holding on past it would suppress the
      // next publisher with something true to say.
      if (current.stateAuthority?.source === event.origin?.source) {
        delete resolved.stateAuthority;
      }
      return resolved;
    }
    case "item.started":
    case "item.updated":
      return {
        ...next,
        state: "running",
        activeItemId: event.itemId,
        task: text(event.payload.summary) ?? text(event.payload.tool) ?? "Working",
      };
    case "item.completed":
      return {
        ...next,
        // A finished item does not mean work is happening - it means some
        // finished. On a session whose turn has already completed this is late
        // news, and claiming "running" for it resurrected sessions that were
        // sitting idle: a Task subagent can outlive the turn that dispatched
        // it, so its completion lands minutes after `turn.completed`.
        //
        // `item.started` still moves a session to running, because work
        // beginning genuinely is work happening.
        state: current.state === "idle" ? "idle" : "running",
        activeItemId: undefined,
        task: text(event.payload.summary) ?? "Tool completed",
      };
    case "token-usage.updated":
      return {
        ...next,
        contextTokens: count(event.payload.contextTokens, current.contextTokens),
        processedTokens: Math.max(
          current.processedTokens,
          count(event.payload.processedTokens, current.processedTokens),
        ),
        usageKnown: true,
      };
    case "runtime.error":
      return { ...next, state: "error", task: text(event.payload.message) ?? "Runtime error" };
    case "rate-limits.updated": {
      // The latest report replaces the previous one wholesale: windows are a
      // reading, not history, and a window that stopped being reported has
      // closed. A payload with no readable window list changes nothing.
      const windows = rateLimitWindows(event.payload.windows);
      return windows === undefined ? next : { ...next, rateLimits: windows };
    }
  }
}

/**
 * Reads a `rate-limits.updated` payload's window list, keeping the entries
 * that name a window and dropping the rest — the same tolerance every other
 * payload field gets at this boundary. A value that is not a list at all
 * yields undefined, which the fold treats as "nothing was said".
 */
function rateLimitWindows(
  value: JsonValue | undefined,
): ReadonlyArray<ProjectedRateLimit> | undefined {
  if (!Array.isArray(value)) return undefined;
  const windows: ProjectedRateLimit[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) continue;
    const id = text(entry.id);
    const label = text(entry.label);
    const usedPercent = entry.usedPercent;
    if (!id || !label || !isJsonNumber(usedPercent) || !Number.isFinite(usedPercent)) continue;
    const window: ProjectedRateLimit = { id, label, usedPercent };
    const resetsAt = text(entry.resetsAt);
    if (resetsAt) window.resetsAt = resetsAt;
    const account = text(entry.account);
    if (account) window.account = account;
    windows.push(window);
  }
  return windows;
}

/**
 * Reads a state report's `claim: {ttlMs}`, with the same boundary tolerance
 * every other payload field gets: a claim that cannot be read is no claim.
 */
function claimTtlMs(value: JsonValue | undefined): number | undefined {
  if (!isJsonObject(value)) return undefined;
  const ttl = value.ttlMs;
  if (!isJsonNumber(ttl) || !Number.isFinite(ttl) || ttl <= 0) return undefined;
  return Math.min(Math.trunc(ttl), MAX_STATE_AUTHORITY_TTL_MS);
}

function text(value: JsonValue | undefined) {
  return isJsonString(value) && value.trim() ? value : undefined;
}
function count(value: JsonValue | undefined, fallback: number) {
  return isJsonNumber(value) && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}
function state(value: JsonValue | undefined): RuntimeProjection["state"] {
  return value === "running" ||
    value === "waiting" ||
    value === "paused" ||
    value === "error" ||
    value === "offline"
    ? value
    : "idle";
}
