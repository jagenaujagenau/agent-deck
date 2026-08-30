import { asString, isJsonNumber, isJsonObject, isJsonString } from "./json-value";
import type { JsonObject, JsonValue } from "./json-value";

/**
 * Reading a user-input question, in every phrasing any runtime has used.
 *
 * The hooks, Pi, and herdr publish a flat `{ question, options }`; the hosted
 * Claude SDK publishes the tool's `questions` array, whose entries carry
 * `question` (or `prompt`, or `header`), options as bare strings or labelled
 * objects, and a `multiSelect` flag. Before this module that decode was
 * written five times across the bridge, the managed runtime, and the
 * adapters — and only one copy knew about `multiSelect`, so a multi-select
 * question could be offered to a device as a single choice.
 */

export type UserInputQuestion = {
  question: string;
  options: string[];
  /**
   * Whether a single choice cannot answer this. True for an explicit
   * multi-select and for a call carrying several questions at once; a caller
   * offering one-tap answers must offer none instead.
   */
  multiSelect: boolean;
};

/**
 * An option is usually `{ label }` and sometimes a bare value that is its own
 * label. Anything object-like without a label is dropped rather than shown as
 * a blank button.
 */
const optionLabels = (value: JsonValue | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const option of value) {
    const label = isJsonObject(option) ? option.label : option;
    if (isJsonString(label) && label) out.push(label);
    else if (isJsonNumber(label) || label === true || label === false) out.push(String(label));
  }
  return out;
};

const text = (value: JsonValue | undefined): string | undefined => {
  const raw = asString(value);
  return raw !== undefined && raw.trim() ? raw : undefined;
};

export function parseUserInputRequest(payload: JsonObject): UserInputQuestion | undefined {
  let question = text(payload.question) ?? text(payload.header);
  let options = optionLabels(payload.options);
  let multiSelect = payload.multiSelect === true;
  const questions = payload.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0];
    if (isJsonObject(first)) {
      question = question ?? text(first.question) ?? text(first.prompt) ?? text(first.header);
      const sdkOptions = optionLabels(first.options);
      if (sdkOptions.length > 0) options = sdkOptions;
      if (first.multiSelect === true || questions.length > 1) multiSelect = true;
    }
  }
  if (question === undefined) return undefined;
  return { question, options, multiSelect };
}
