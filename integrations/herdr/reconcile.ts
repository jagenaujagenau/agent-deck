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
 * Corrections are published as canonical runtime events (see index.ts). An
 * earlier version wrote them into the hooks' private state files, back when
 * the bridge discarded any projection that disagreed with a heartbeat; that
 * gate is gone (ADR-0001), and a blocked claim now carries a State Authority
 * lease so the hooks' delayed reports cannot overwrite it (ADR-0002).
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

/** A session as the bridge currently reports it. */
export interface StoredSession {
  readonly state: string;
  /** A live approval the hooks are already blocked on, and own outright. */
  readonly holdingApproval: boolean;
  /**
   * Whether this integration is the one that put the session in `waiting`.
   *
   * Held rather than inferred from the task text. The task now carries the
   * question read off the screen, which is indistinguishable from something a
   * hook wrote - and withdrawing a claim that was never ours would report a
   * session as idle while it sat at a prompt.
   */
  readonly claimedByUs: boolean;
}

export type Correction = "block" | "clear";

/**
 * Whether this session's reported state needs correcting, given what Herdr sees.
 *
 * Idempotent rather than edge-triggered: a pass states the conclusion the
 * current facts support instead of remembering a transition. An edge-triggered
 * version goes wrong the first time something else writes over the claim,
 * because the transition it was waiting to re-fire has already happened.
 */
export function correctionFor(status: HerdrStatus, stored: StoredSession): Correction | undefined {
  // An approval in flight is the hooks' to describe: they know which tool is
  // asking, and a device can answer it. Herdr only sees that a UI is up.
  if (stored.holdingApproval) return undefined;
  if (status === "blocked")
    return stored.claimedByUs && stored.state === "waiting" ? undefined : "block";
  return stored.claimedByUs ? "clear" : undefined;
}
