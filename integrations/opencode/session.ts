import { asString, isJsonObject, type JsonValue } from "./payload";

/**
 * Deciding which OpenCode sessions the deck should speak for, and what to call
 * them.
 *
 * Kept apart from the plugin itself because these are the two rules that go
 * quietly wrong: a subagent reported as its parent corrupts the parent's state,
 * and an id derived differently from the way the bridge derives it produces a
 * session nothing else can find.
 */

/**
 * Tracks which sessions belong to subagents, so their events can be threaded
 * onto the parent instead of dropped or reported as sessions of their own.
 *
 * OpenCode gives a subagent its own session with a `parentID`, and reports its
 * lifecycle through the same stream as the real one. Left alone, a subagent
 * going idle marks the whole session idle while the parent is still working -
 * Herdr hit exactly this. The deck wants the child's work visible but filed
 * under the parent, tagged with the subagent's identity.
 *
 * Parentage is learned rather than asked for: it arrives once, on the event
 * that creates the child, and every later event about that session carries only
 * its id.
 */
export class SubagentSessions {
  readonly #links = new Map<string, { parentId: string; name?: string }>();

  /**
   * Records parentage if this event announces a child session.
   *
   * Takes a raw payload value because it is handed a field off an event:
   * narrowing belongs here, next to the rule that depends on it, rather than at
   * each call site checking a structure it has no stake in.
   */
  observe(info: JsonValue | undefined): void {
    if (!isJsonObject(info)) return;
    const id = asString(info.id);
    const parentID = asString(info.parentID);
    if (id === undefined || !parentID) return;
    // The title is the task's own wording and can arrive on a later update,
    // so an already-known child keeps the best name seen so far.
    const name = asString(info.title)?.trim() || this.#links.get(id)?.name;
    this.#links.set(id, { parentId: parentID, name });
  }

  /** True when this session is a subagent's, and its events need threading. */
  isChild(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.#links.has(sessionId);
  }

  /**
   * The top-level session a subagent's work should be reported on. Subagents
   * can nest, so this walks up; the visited set makes a malformed cycle
   * terminate instead of hanging the event loop.
   */
  rootOf(sessionId: string): string {
    const visited = new Set<string>();
    let current = sessionId;
    while (!visited.has(current)) {
      visited.add(current);
      const link = this.#links.get(current);
      if (!link) return current;
      current = link.parentId;
    }
    return current;
  }

  /** What the subagent was asked to do, when its session announced a title. */
  nameOf(sessionId: string): string | undefined {
    return this.#links.get(sessionId)?.name;
  }
}

/** The deck's state vocabulary, from OpenCode's session status strings. */
export function stateFromStatus(status: JsonValue | undefined): "idle" | "running" | undefined {
  const value = asString(status);
  if (value === undefined) return undefined;
  switch (value.toLowerCase()) {
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
