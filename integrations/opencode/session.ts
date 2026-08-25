import { createHash } from "node:crypto";

/**
 * Deciding which OpenCode sessions the deck should speak for, and what to call
 * them.
 *
 * Kept apart from the plugin itself because these are the two rules that go
 * quietly wrong: a subagent reported as its parent corrupts the parent's state,
 * and an id derived differently from the way the bridge derives it produces a
 * session nothing else can find.
 */

/** The deck's id for a session, derived the way every other adapter derives it. */
export function deckAgentId(sessionId: string): string {
  return `opencode-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

/**
 * Tracks which sessions belong to subagents, so their events can be dropped.
 *
 * OpenCode gives a subagent its own session with a `parentID`, and reports its
 * lifecycle through the same stream as the real one. Left alone, a subagent
 * going idle marks the whole session idle while the parent is still working -
 * Herdr hit exactly this and its plugin carries the same guard.
 *
 * Parentage is learned rather than asked for: it arrives once, on the event
 * that creates the child, and every later event about that session carries only
 * its id.
 */
export class SubagentSessions {
  readonly #children = new Set<string>();

  /**
   * Records parentage if this event announces a child session.
   *
   * Takes `unknown` because it is handed a field off an event payload: narrowing
   * belongs here, next to the rule that depends on it, rather than at each call
   * site asserting a shape it has not checked.
   */
  observe(info: unknown): void {
    if (info === null || typeof info !== "object") return;
    const { id, parentID } = info as { id?: unknown; parentID?: unknown };
    // SAFETY: guarded on `info` being a non-null object immediately above; both
    // fields are then checked for type and emptiness before either is used.
    if (typeof id === "string" && typeof parentID === "string" && parentID) {
      this.#children.add(id);
    }
  }

  has(sessionId: string): boolean {
    return this.#children.has(sessionId);
  }

  /** True when this event is about a subagent and must not be reported. */
  shouldDrop(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.#children.has(sessionId);
  }
}

/** The deck's state vocabulary, from OpenCode's session status strings. */
export function stateFromStatus(status: unknown): "idle" | "running" | undefined {
  if (typeof status !== "string") return undefined;
  switch (status.toLowerCase()) {
    case "idle":
      return "idle";
    case "active":
    case "busy":
    case "pending":
    case "running":
    case "streaming":
    case "working":
      return "running";
    default:
      // An unrecognised status is not a reason to claim a state. Saying nothing
      // leaves the last known one standing, which is likelier to be true.
      return undefined;
  }
}
