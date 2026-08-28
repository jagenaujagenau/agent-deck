import type { AgentEvent } from "./types";

/**
 * How a session's raw events become the tabs every surface shows.
 *
 * Shared logic mirrored from AgentConversation.kt and Conversation.swift: a
 * conversation assembled twice is two conversations, and a new client should
 * not have to rediscover these rules from the wire.
 */

/**
 * The session view's event source: the bridge's retained history plus anything
 * the live snapshot has that history has not caught up with. The live copy is
 * fresher and normally wins on id — but the snapshot is a lossy view of the
 * same event: it clips `detail` and drops `command` and `diff` outright.
 * Taking it wholesale would replace a whole message with its first 400
 * characters and strip the command off a terminal entry.
 */
export function mergeSessionEvents(
  history: ReadonlyArray<AgentEvent>,
  live: ReadonlyArray<AgentEvent>,
): AgentEvent[] {
  if (history.length === 0) return [...live];
  const byId = new Map<string, AgentEvent>();
  for (const event of history) byId.set(event.id, event);
  for (const event of live) {
    const known = byId.get(event.id);
    byId.set(
      event.id,
      known === undefined
        ? event
        : {
            ...event,
            detail: isClippedForm(event.detail, known.detail) ? known.detail : event.detail,
            command: event.command ?? known.command,
            diff: event.diff ?? known.diff,
          },
    );
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Whether `live` is the snapshot's shortened form of `full`: the snapshot cuts
 * `detail` and marks the cut with an ellipsis, so its text is a prefix of what
 * history holds. Restoring only that exact shape leaves a genuine revision
 * alone.
 */
function isClippedForm(live: string | undefined, full: string | undefined): boolean {
  if (live === undefined || full === undefined || !live.endsWith("…")) return false;
  return full.length > live.length && full.startsWith(live.slice(0, -1).trimEnd());
}

export type ConversationRole = "user" | "agent";

export interface ConversationEntry {
  event: AgentEvent;
  role: ConversationRole;
  content: string;
}

/** How close two identical user messages must be to count as one delivery. */
const DUPLICATE_WINDOW_MS = 10_000;

/**
 * The chat between the person and the agent, oldest first.
 *
 * A prompt can arrive twice — once from the hook the moment it was typed, once
 * from the transcript a beat later — so adjacent identical user messages
 * within a few seconds collapse to one.
 */
export function conversationEntries(events: ReadonlyArray<AgentEvent>): ConversationEntry[] {
  const ordered = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const entries: ConversationEntry[] = [];
  for (const event of ordered) {
    const userMessage =
      event.summary.startsWith("Remote command:") ||
      event.kind === "user" ||
      // Back-compat: history written before user events were first-class.
      (event.kind === "thought" && event.summary === "Received instruction");
    const detail = (event.detail ?? "").trim();
    let entry: ConversationEntry | undefined;
    if (userMessage && detail) {
      entry = { event, role: "user", content: detail };
    } else if (isAgentResponse(event)) {
      const content = (event.detail ?? event.summary).trim();
      if (content) entry = { event, role: "agent", content };
    }
    if (entry === undefined) continue;
    const previous = entries[entries.length - 1];
    const duplicateDelivery =
      previous !== undefined &&
      previous.role === "user" &&
      entry.role === "user" &&
      previous.content === entry.content &&
      closeInTime(previous.event.createdAt, entry.event.createdAt);
    if (!duplicateDelivery) entries.push(entry);
  }
  return entries;
}

/** The train of thought: every reasoning block, oldest first. */
export function reasoningEvents(events: ReadonlyArray<AgentEvent>): AgentEvent[] {
  return [...events]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter(
      (event) =>
        event.kind === "thought" &&
        event.summary !== "Received instruction" &&
        (event.detail ?? "").trim() !== "",
    );
}

/** The shell side of the session: every event that carries a command, oldest first. */
export function terminalEvents(events: ReadonlyArray<AgentEvent>): AgentEvent[] {
  return [...events]
    .filter((event) => (event.command ?? "").trim() !== "")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isAgentResponse(event: AgentEvent): boolean {
  // A subagent speaks exactly once, in the detail of its completion. It
  // carries a tool ("Task") and would fail every test below, which left a
  // session read through a subagent showing tool calls and not one word.
  if (isSubagentMessage(event)) return true;
  return (
    event.kind === "output" &&
    !event.summary.startsWith("Remote command:") &&
    event.tool === undefined &&
    event.command === undefined &&
    (event.summary === "Response" ||
      (event.detail ?? "").trim() !== "" ||
      (event.summary !== "Activity" && !event.summary.endsWith(" completed")))
  );
}

function isSubagentMessage(event: AgentEvent): boolean {
  return (
    event.subagentId !== undefined &&
    event.tool === "Task" &&
    (event.detail ?? "").trim() !== ""
  );
}

function closeInTime(first: string, second: string): boolean {
  const a = Date.parse(first);
  const b = Date.parse(second);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) < DUPLICATE_WINDOW_MS;
}

export interface TurnThread {
  /** The exchange's id, where any event in it carried one. */
  turnId?: string;
  events: AgentEvent[];
}

/**
 * The session as threads: one instruction and everything done in its service.
 *
 * A `user` event always opens a thread — an instruction begins an exchange
 * even when nothing was tagged. Between instructions, a change of `turnId`
 * also opens one, which is what splits work the transcript replayed without
 * its user line. Untagged events stay with the thread they follow, because a
 * runtime that never tags anything should still read as one conversation.
 */
export function turnThreads(events: ReadonlyArray<AgentEvent>): TurnThread[] {
  const ordered = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const threads: TurnThread[] = [];
  for (const event of ordered) {
    const current = threads[threads.length - 1];
    const opens =
      current === undefined ||
      event.kind === "user" ||
      (event.turnId !== undefined &&
        current.turnId !== undefined &&
        event.turnId !== current.turnId);
    if (opens) {
      threads.push({ turnId: event.turnId, events: [event] });
      continue;
    }
    current.events.push(event);
    current.turnId ??= event.turnId;
  }
  return threads;
}
