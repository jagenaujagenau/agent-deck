import { createHash } from "node:crypto";

/**
 * Reconciling what Herdr can see with what the deck believes.
 *
 * Herdr reads the terminal, so it sees things the Claude Code hooks structurally
 * cannot: a hook fires for tool calls and questions, never for the runtime's own
 * UI. A session frozen on "Resume from summary" is asking for a keypress while
 * every hook stays silent, which is why the deck reported eight such sessions as
 * "Ready for an instruction".
 *
 * It also gives a session that is merely idle somewhere to receive words, which
 * a hook cannot: hooks only run when the runtime calls them, and an idle session
 * calls nothing.
 *
 * Corrections are written to the hook state file rather than published as
 * runtime events. The bridge treats a heartbeat as authoritative and uses a
 * projection only where the two already agree, so an event on its own cannot
 * move a session's state - it is checked against the heartbeat, not merged into
 * it. The state file is what the heartbeat is built from, which makes it the
 * only place a correction actually lands.
 */

/** Herdr's own lifecycle vocabulary, which is richer than the deck's. */
export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One agent as Herdr reports it, reduced to the fields this integration reads. */
export interface HerdrAgent {
  readonly kind: string;
  readonly sessionId: string;
  readonly target: string;
  readonly status: HerdrStatus;
}

/**
 * The runtimes the deck has an adapter for, and so the only ones whose ids it
 * can be holding. Herdr manages others too, and those are left alone rather
 * than published under an id nothing else uses.
 */
const DECK_RUNTIMES = new Set(["claude", "codex", "opencode"]);

/**
 * The deck's id for a session, derived exactly as the hooks derive it.
 *
 * Both sides hash the runtime's own session id, so the two agree without either
 * having to publish a mapping - the correlation is a consequence of the scheme
 * rather than a thing to keep in sync.
 */
export function deckAgentId(kind: string, sessionId: string): string {
  return `${kind}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

export function isDeckRuntime(kind: string): boolean {
  return DECK_RUNTIMES.has(kind);
}

/**
 * Whether words can be put into this session right now.
 *
 * "done" is the same underlying idle state as "idle" for work that finished
 * unseen, so both accept a prompt. "unknown" does not: Herdr says only that an
 * agent is there, not that it is ready, and typing into a session that is
 * actually mid-turn is worse than waiting for the next pass.
 */
export function acceptsPrompt(status: HerdrStatus): boolean {
  return status === "idle" || status === "done";
}

/**
 * The activity line this integration claims a session with.
 *
 * Used as a marker as well as a description: it is the one task text this
 * integration writes, so seeing it is how a later pass knows the claim is its
 * own and may be withdrawn. Anything else in that field belongs to the hooks
 * and is left alone.
 */
export const TERMINAL_PROMPT_TASK = "Waiting at a prompt in the terminal";

/** A session as the hooks have recorded it, reduced to what a correction reads. */
export interface StoredSession {
  readonly state: string;
  readonly task: string;
  /** A live approval the hooks are already blocked on, and own outright. */
  readonly holdingApproval: boolean;
}

export type Correction = "block" | "clear";

/**
 * Whether this session's recorded state needs correcting, given what Herdr sees.
 *
 * Idempotent rather than edge-triggered: a pass states the conclusion the
 * current facts support instead of remembering a transition. An edge-triggered
 * version goes wrong the first time a hook writes over the claim, because the
 * transition it was waiting to re-fire has already happened.
 *
 * A claim is only ever withdrawn when the task text is still this integration's
 * own. A session the hooks have since described some other way has moved on,
 * and overwriting that would be trading a fresh account for a stale one.
 */
export function correctionFor(status: HerdrStatus, stored: StoredSession): Correction | undefined {
  // An approval in flight is the hooks' to describe: they know which tool is
  // asking, and a device can answer it. Herdr only sees that a UI is up.
  if (stored.holdingApproval) return undefined;
  if (status === "blocked") {
    const alreadySaid = stored.state === "waiting" && stored.task === TERMINAL_PROMPT_TASK;
    return alreadySaid ? undefined : "block";
  }
  return stored.task === TERMINAL_PROMPT_TASK ? "clear" : undefined;
}
