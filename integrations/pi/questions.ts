/**
 * Reading an "ask the user" tool call, in the one place both sites agree on.
 *
 * `tool_call` needs the question to offer it to a phone; `tool_execution_start`
 * needs to recognise the same call to say the session is blocked. Deriving that
 * twice is how the two drift into disagreeing about what a question even is.
 */

export function isAskUserQuestionTool(toolName: string): boolean {
  return /ask.?user.?question/i.test(toolName);
}

export interface AskedQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
}

export function askedQuestion(input: Record<string, unknown>): AskedQuestion {
  const questions = Array.isArray(input.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  // A tool may carry its question in a `questions` array or inline on the call
  // itself; both shapes are in use, so neither is treated as the malformed one.
  const first = questions[0] ?? input;
  const options = Array.isArray(first.options)
    ? first.options
        .map((option) =>
          // SAFETY: guarded on `option` being a non-null object immediately
          // above, which is the only claim the assertion makes; every value
          // read from it is then coerced rather than trusted.
          typeof option === "object" && option
            ? String((option as Record<string, unknown>).label ?? "")
            : String(option),
        )
        .filter(Boolean)
    : [];
  return {
    question: String(first.question ?? first.header ?? "Agent needs your answer"),
    options,
  };
}
