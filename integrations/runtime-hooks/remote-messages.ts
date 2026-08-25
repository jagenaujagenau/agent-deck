import type { RemoteCommand } from "../../packages/agent-adapter/src/index";

/** Remote commands that carry text for the model rather than a control decision. */
const MESSAGE_ACTIONS = new Set(["prompt", "steer", "follow_up"]);

/** The subset of AgentDeckClient this module needs, so tests can drive it without a bridge. */
export type CommandQueue = {
  commands(agentId: string): Promise<RemoteCommand[]>;
  acknowledge(agentId: string, commandId: string): Promise<unknown>;
};

export function isRemoteMessage(command: RemoteCommand): boolean {
  return (
    MESSAGE_ACTIONS.has(command.action) &&
    typeof command.value === "string" &&
    command.value.trim().length > 0
  );
}

/**
 * Takes every queued message for this session, oldest first, acknowledging each so it is delivered
 * exactly once. Approve/reject decisions are left untouched — `waitForDecision` owns those, and a
 * tool call blocked on approval must still find its decision in the queue.
 */
export async function drainRemoteMessages(queue: CommandQueue, agentId: string): Promise<string[]> {
  const pending = (await queue.commands(agentId))
    .filter(isRemoteMessage)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

  const delivered: string[] = [];
  for (const command of pending) {
    // Acknowledge before delivering: a redelivered instruction would run twice, which is worse
    // than losing one to a crash in the millisecond between the ack and the hook's stdout write.
    try {
      await queue.acknowledge(agentId, command.id);
    } catch {
      continue; // Still queued — it will be picked up at the next turn boundary.
    }
    delivered.push(command.value!.trim());
  }
  return delivered;
}

/**
 * Renders queued messages as the `reason` of a blocked Stop hook. Claude Code feeds that text back
 * to the model as the instruction to continue with, which is the only way a hook can put words into
 * a running session.
 */
export function stopHookReason(messages: string[]): string {
  if (messages.length === 1) {
    return `The user sent this from Agent Deck while you were working:\n\n${messages[0]}`;
  }
  const numbered = messages.map((message, index) => `${index + 1}. ${message}`).join("\n\n");
  return `The user sent these from Agent Deck while you were working, oldest first:\n\n${numbered}`;
}

/** The exact JSON contract Claude Code reads from a Stop hook to keep a session going. */
export function stopHookDecision(messages: string[]): string {
  return JSON.stringify({ decision: "block", reason: stopHookReason(messages) });
}

/**
 * Activity line for a session holding undelivered messages. A hook can only inject at the end of a
 * turn, so a message sent to an idle session waits for one — say so rather than letting it look
 * sent. Reported per heartbeat and never written to the state file, so it clears on delivery.
 */
export function queuedMessageNotice(count: number): string | undefined {
  if (count < 1) return undefined;
  return count === 1
    ? "1 message queued · delivers at the next turn"
    : `${count} messages queued · deliver at the next turn`;
}

/** Counts undelivered messages without acknowledging any — only the Stop hook may drain. */
export async function countQueuedMessages(
  queue: Pick<CommandQueue, "commands">,
  agentId: string,
): Promise<number> {
  return (await queue.commands(agentId)).filter(isRemoteMessage).length;
}

/**
 * Renders queued messages as extra context on a prompt the user is submitting.
 *
 * The Stop hook can only deliver what was queued while a turn was running: it
 * fires at the end of one, and a session sitting idle runs none. When the user
 * comes back to the terminal and types, that is the first moment anything
 * queued in the meantime can reach the model, so it is folded into their turn
 * rather than left waiting for the turn after.
 */
export function promptContext(messages: string[]): string {
  const body =
    messages.length === 1
      ? messages[0]
      : messages.map((message, index) => `${index + 1}. ${message}`).join("\n\n");
  const preface =
    messages.length === 1
      ? "The user sent this from Agent Deck before this prompt:"
      : "The user sent these from Agent Deck before this prompt, oldest first:";
  return `${preface}\n\n${body}`;
}
