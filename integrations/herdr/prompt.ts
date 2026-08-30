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

  // Walk up through the menu, stepping over wrapped labels. A long option
  // description continues on an indented line, and treating that as the end of
  // the menu read Claude Code's model picker as two choices out of five - with
  // the third's text taken for the question.
  const indent = (line: string) => line.length - line.trimStart().length;
  const menuIndent = indent(lines[end]!);
  let start = end;
  while (start > 0) {
    const previous = lines[start - 1]!;
    const isOption = OPTION.test(previous);
    const isWrap = previous.trim() !== "" && indent(previous) > menuIndent;
    if (!isOption && !isWrap) break;
    start -= 1;
  }

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
  // A partial menu is refused outright. Showing two of five choices would let
  // someone press "2" for what the terminal has numbered differently, which is
  // a wrong action taken confidently - worse than showing nothing at all.
  if (!options.every((option, index) => option.number === index + 1)) return undefined;

  return { question: questionAbove(lines.slice(0, start)), options };
}

/** A horizontal rule, a box edge - drawn, not said. */
const RULE = /^[\s─━│┌┐└┘├┤┬┴┼╭╮╯╰=_-]+$/;

/**
 * The option to actually press, for a choice made against an earlier reading
 * of this screen.
 *
 * An answer can arrive minutes after the prompt was read, and keys know
 * nothing about what they land on: the pane may hold a different session by
 * now, or the same session may be asking a different question — pressing "2"
 * against either picks something nobody chose. The choice is honoured only
 * when the live screen still asks the same question and still offers the
 * chosen label, and the number pressed is the live one, because a menu that
 * kept its labels may still have renumbered them.
 */
export function liveChoice(
  expected: TerminalPrompt,
  live: TerminalPrompt | undefined,
  label: string,
): PromptOption | undefined {
  if (live === undefined || live.question !== expected.question) return undefined;
  return live.options.find((option) => option.label === label);
}

/**
 * The line that is actually being asked, from the prose above a menu.
 *
 * Not simply the nearest one. Runtimes put a footnote or a link immediately
 * above their choices - Claude Code's trust prompt ends with "Security guide" -
 * and taking the closest line put that on the watch instead of the question.
 * A line carrying a question mark wins; failing that, the nearest line long
 * enough to be a sentence rather than a label.
 */
function questionAbove(above: ReadonlyArray<string>): string {
  const candidates = above
    .map((line) => line.trim())
    .filter((line) => line !== "" && !RULE.test(line))
    .reverse()
    // Far enough back to clear a footnote, near enough not to reach the last
    // thing the agent said before the prompt appeared.
    .slice(0, 8);
  return (
    candidates.find((line) => line.includes("?")) ??
    candidates.find((line) => line.length >= 25) ??
    candidates[0] ??
    "The terminal is asking for a choice"
  );
}
