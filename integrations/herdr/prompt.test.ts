import { describe, expect, test } from "bun:test";
import { parsePrompt } from "./prompt";

describe("parsePrompt", () => {
  /**
   * Captured verbatim from a session on this machine that had been sitting
   * blocked for hours while the deck reported it idle. It is the reason any of
   * this exists, so it is the fixture.
   */
  const resume = `
  ※ recap: Goal: bring the Ruby port of fx up to date with upstream.

─────────────────────────────────────────────────────────────
  This session is 16h 40m old and 342.5k tokens.

  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.

  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again

  Enter to confirm · Esc to cancel
`;

  test("reads the choices off a session frozen at startup", () => {
    const prompt = parsePrompt(resume);
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Resume from summary (recommended)",
      "Resume full session as-is",
      "Don't ask me again",
    ]);
  });

  test("knows which choice Enter alone would take", () => {
    const prompt = parsePrompt(resume);
    expect(prompt?.options.find((option) => option.selected)?.number).toBe(1);
  });

  test("takes the question, not the paragraph explaining it", () => {
    // Runtimes explain themselves at length above the menu; the line closest
    // to the choices is the one actually being asked.
    expect(parsePrompt(resume)?.question).toContain("Resuming the full session");
  });

  test("reads a permission box the same way", () => {
    const prompt = parsePrompt(`
Bash command
  rm -rf build

Do you want to proceed?
❯ 1. Yes
  2. No, and tell Claude what to do differently
`);
    expect(prompt?.question).toBe("Do you want to proceed?");
    expect(prompt?.options).toHaveLength(2);
  });

  test("an enumerated list in ordinary output is not a question", () => {
    // Agents print numbered lists constantly. Treating one as answerable would
    // put a request on someone's watch for a paragraph of prose.
    expect(
      parsePrompt(`
Here is what I found:
  1. The parity gate discards the projection
  2. The heartbeat reports zero tokens
  3. Both were invisible in tests

Shall I keep going with the migration?
`),
    ).toBeUndefined();
  });

  test("a single choice is a statement, not a choice", () => {
    expect(parsePrompt("Something happened\n❯ 1. Acknowledge\n")).toBeUndefined();
  });

  test("a screen with no menu at all yields nothing", () => {
    expect(parsePrompt("⏺ Done. 221 tests pass.\n\n❯ ")).toBeUndefined();
  });

  test("only the menu still awaiting an answer is read", () => {
    // Scrollback holds every menu the session ever drew.
    const prompt = parsePrompt(`
Do you want to proceed?
❯ 1. Yes
  2. No

⏺ Ran it.

Which branch should I target?
❯ 1. main
  2. develop
`);
    expect(prompt?.question).toBe("Which branch should I target?");
    expect(prompt?.options.map((option) => option.label)).toEqual(["main", "develop"]);
  });

  test("terminal dressing does not reach the question", () => {
    const dressed = "[1mDo you want to proceed?[0m\n[36m❯ 1. Yes[0m\n  2. No\n";
    const prompt = parsePrompt(dressed);
    expect(prompt?.question).toBe("Do you want to proceed?");
    expect(prompt?.options[0]?.label).toBe("Yes");
  });

  test("a rule above the menu is not mistaken for the question", () => {
    const prompt = parsePrompt(`
Pick one:
─────────────────────────
❯ 1. First
  2. Second
`);
    expect(prompt?.question).toBe("Pick one:");
  });
});

describe("questionAbove", () => {
  /**
   * Captured from Claude Code's startup trust prompt. The line immediately
   * above the choices is a link label, and taking the nearest line put
   * "Security guide" on the watch instead of the question.
   */
  const trust = `
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team).

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

  test("skips a footnote sitting between the question and the choices", () => {
    expect(parsePrompt(trust)?.question).toContain("Quick safety check");
  });

  test("a statement without a question mark still reads as the question", () => {
    // The resume prompt asks nothing explicitly; the sentence explaining the
    // choice is the closest thing to one.
    const prompt = parsePrompt(`
  This session is 16h 40m old.

  Resuming the full session will consume a substantial portion of your usage limits.

  ❯ 1. Resume from summary
    2. Resume full session as-is
`);
    expect(prompt?.question).toContain("Resuming the full session");
  });

  test("a box drawn around the menu is not the question", () => {
    const prompt = parsePrompt(`
Do you want to proceed?
╭──────────────────────╮
❯ 1. Yes
  2. No
`);
    expect(prompt?.question).toBe("Do you want to proceed?");
  });
});

describe("menus that wrap", () => {
  /**
   * Claude Code's model picker, captured live. Option three's description runs
   * onto a second line, and treating that as the end of the menu read this as
   * two choices out of five - with option three's text taken for the question.
   */
  const models = `
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions.

    1. Default (recommended)  Opus 5 with 1M context · Best for everyday tasks
  ❯ 2. Opus (1M context)      Opus 5 with 1M context · Best for everyday tasks
    3. Fable                  Fable 5 · Most capable for your hardest and longest-running
                              tasks
    4. Sonnet                 Sonnet 5 · Efficient for routine tasks
    5. Haiku                  Haiku 4.5 · Fastest for quick answers

  Enter to set as default · Esc to cancel
`;

  test("a wrapped label does not truncate the menu", () => {
    expect(parsePrompt(models)?.options.map((option) => option.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test("the cursor is still found after a wrap", () => {
    expect(parsePrompt(models)?.options.find((option) => option.selected)?.number).toBe(2);
  });

  test("a menu missing its first choices is refused, not shown in part", () => {
    // Showing two of five would let someone press "2" for what the terminal has
    // numbered differently - a wrong action taken confidently.
    expect(
      parsePrompt(`
Pick one:
  ❯ 3. Third
    4. Fourth
`),
    ).toBeUndefined();
  });

  test("a menu that skips a number is refused", () => {
    expect(parsePrompt("Pick:\n❯ 1. One\n  3. Three\n")).toBeUndefined();
  });
});
