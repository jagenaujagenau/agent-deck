/**
 * Reading a question off a terminal that the hooks never saw.
 *
 * A runtime's own UI - "Resume from summary", a permission box - is drawn, not
 * announced. No hook fires for it, so a session can sit blocked on a keypress
 * while the deck reports it as idle. Herdr can say a pane is blocked and can
 * show what is on it; this turns that into something a watch can answer.
 *
 * Parsing a screen is only safe because of what it is used for: an answerable
 * question, or nothing. A misread produces no request rather than a wrong one,
 * which is why every rule below is a reason to refuse.
 */

/** A numbered choice, as the terminal draws it. */
export interface PromptOption {
  readonly number: number;
  readonly label: string;
  /** The one the cursor is on, which is what Enter alone would pick. */
  readonly selected: boolean;
}

export interface TerminalPrompt {
  readonly question: string;
  readonly options: ReadonlyArray<PromptOption>;
}

/** Terminal output arrives dressed; the text underneath is what parses. */
function plain(screen: string): string[] {
  return screen
    .replace(/\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
}

const OPTION = /^\s*([❯>]?)\s*(\d+)[.)]\s+(.+?)\s*$/;

/**
 * Whether the screen is showing something a person is expected to answer.
 *
 * Numbered lines alone are not enough - agents print numbered lists constantly.
 * A cursor marker or an explicit confirmation hint is what separates a menu
 * from prose that happens to be enumerated.
 */
function looksInteractive(lines: string[], options: ReadonlyArray<PromptOption>): boolean {
  if (options.some((option) => option.selected)) return true;
  const tail = lines.slice(-6).join(" ").toLowerCase();
  return tail.includes("to confirm") || tail.includes("esc to cancel");
}

/**
 * The prompt on this screen, or nothing.
 *
 * Only the last run of options is considered: a scrollback holds every menu the
 * session has ever shown, and the one still awaiting an answer is the one at
 * the bottom.
 */
export function parsePrompt(screen: string): TerminalPrompt | undefined {
  const lines = plain(screen);

  let end = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (OPTION.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  if (end === -1) return undefined;

  let start = end;
  while (start > 0 && OPTION.test(lines[start - 1]!)) start -= 1;

  const options: PromptOption[] = [];
  for (const line of lines.slice(start, end + 1)) {
    const match = OPTION.exec(line);
    if (!match) continue;
    options.push({
      number: Number(match[2]),
      label: match[3]!.trim(),
      selected: match[1] !== "",
    });
  }

  // One option is a statement, not a choice.
  if (options.length < 2) return undefined;
  if (!looksInteractive(lines, options)) return undefined;

  // The question is the nearest prose above the menu. Runtimes explain
  // themselves at length, so the last line before it is the one being asked.
  const question = lines
    .slice(0, start)
    .reverse()
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^[─-╿\-_=]+$/.test(line));

  return { question: question ?? "The terminal is asking for a choice", options };
}
