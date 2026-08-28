/**
 * The harness's own notice that a background agent finished.
 *
 * Claude Code injects one of these into the transcript as a *user* turn, which
 * is what it is technically and not at all what it is to a reader: nobody typed
 * it, and published verbatim it lands in the app's chat as a right-aligned
 * bubble containing a wall of XML — a task id, a path to a file on a machine the
 * phone cannot see, a note addressed to the model, and a usage blob.
 *
 * Two of the fields are worth reading. `<summary>` says which agent finished,
 * and `<result>` is the only thing it actually said. The rest is plumbing.
 */
export type TaskNotification = {
  /** `Agent "…" finished` — the runtime's own wording, kept. */
  summary: string;
  /** What the agent reported back, or the summary again when it reported nothing. */
  result: string;
};

/** Greedy to the last closing tag: a result is markdown and may quote one of these. */
const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*)</${name}>`);

const SUMMARY = field("summary");
const RESULT = field("result");

/**
 * Reads a task notification, or returns undefined for ordinary text.
 *
 * Anchored at the start so a message that merely quotes a notification — asking
 * about one, pasting one — stays the message the person wrote.
 */
export function parseTaskNotification(text: string): TaskNotification | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<task-notification>")) return undefined;

  const summary = trimmed.match(SUMMARY)?.[1]?.trim() ?? "";
  const result = trimmed.match(RESULT)?.[1]?.trim() ?? "";
  // A notification with neither is all plumbing and worth nothing on a phone.
  if (!summary && !result) return undefined;

  return { summary: summary || "A background agent finished", result: result || summary };
}
