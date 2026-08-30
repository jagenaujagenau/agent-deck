/**
 * Reading an "ask the user" tool call, in the one place both sites agree on.
 *
 * `tool_call` needs the question to offer it to a phone; `tool_execution_start`
 * needs to recognise the same call to say the session is blocked. Deriving that
 * twice is how the two drift into disagreeing about what a question even is.
 */

import { parseUserInputRequest } from "../../packages/agent-adapter/src/user-input";
import type { JsonObject } from "./payload";

export function isAskUserQuestionTool(toolName: string): boolean {
  return /ask.?user.?question/i.test(toolName);
}

export interface AskedQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
}

export function askedQuestion(input: JsonObject): AskedQuestion {
  // The phrasing decode is shared with every reader of a user-input question;
  // only a single-answer question maps onto a device's option list.
  const parsed = parseUserInputRequest(input);
  return parsed === undefined
    ? { question: "Agent needs your answer", options: [] }
    : { question: parsed.question, options: parsed.multiSelect ? [] : parsed.options };
}
