/**
 * Reading an "ask the user" tool call, in the one place both sites agree on.
 *
 * `tool_call` needs the question to offer it to a phone; `tool_execution_start`
 * needs to recognise the same call to say the session is blocked. Deriving that
 * twice is how the two drift into disagreeing about what a question even is.
 */

import { asObject, type JsonObject, type JsonValue } from "./payload";

export function isAskUserQuestionTool(toolName: string): boolean {
  return /ask.?user.?question/i.test(toolName);
}

export interface AskedQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
}

/**
 * An option is usually `{ label }` and sometimes a bare value that is its own
 * label. Anything object-like without a label collapses to the empty string,
 * which the caller filters out rather than showing as a blank button.
 */
function optionLabel(option: JsonValue): string {
  return option !== null && Object(option) === option
    ? String(asObject(option)?.label ?? "")
    : String(option);
}

export function askedQuestion(input: JsonObject): AskedQuestion {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  // A tool may carry its question in a `questions` array or inline on the call
  // itself; both forms are in use, so neither is treated as the malformed one.
  const first = asObject(questions[0] ?? input) ?? {};
  const options = Array.isArray(first.options)
    ? first.options.map(optionLabel).filter(Boolean)
    : [];
  return {
    question: String(first.question ?? first.header ?? "Agent needs your answer"),
    options,
  };
}
