import { readFileSync } from "node:fs";
import { asString, isJsonObject, parseJson } from "./json-value";
import type { JsonObject, JsonValue } from "./json-value";

/**
 * Gemini CLI's conversation file, read for the facts its hooks never send.
 *
 * The file is one JSON document rewritten in place under the project temp
 * dir's `chats/` — its path arrives as the hook payload's `transcript_path`.
 * Shape, taken from the 0.57.0 writer (`recordMessage`/`newMessage`): a
 * `messages` array where each "gemini" message may carry `model`, `thoughts`
 * (`{subject, description}`), and `tokens`
 * (`{input, prompt, candidates, total, cached, thoughts, tool}`). Because the
 * whole document is rewritten, it cannot be tailed like a JSONL transcript;
 * one read per turn at AfterAgent is the honest cadence.
 */

export type GeminiThought = { id: string; text: string };
export type GeminiConversationRead = {
  model?: string;
  /** What the model was fed on the newest exchange — the live context pressure. */
  contextTokens: number;
  /** Everything processed across the conversation, monotonic. */
  processedTokens: number;
  thoughts: GeminiThought[];
};

const EMPTY: GeminiConversationRead = { contextTokens: 0, processedTokens: 0, thoughts: [] };

function tokenNumber(tokens: JsonObject, key: string): number {
  const value = tokens[key];
  return Number(value) === value ? value : 0;
}

function thoughtText(entry: JsonValue): string {
  if (!isJsonObject(entry)) return "";
  const subject = asString(entry.subject)?.trim() ?? "";
  const description = asString(entry.description)?.trim() ?? "";
  if (subject && description) return `${subject}\n${description}`;
  return description || subject;
}

export function readGeminiConversation(
  conversationPath: string,
  sessionKey: string,
): GeminiConversationRead {
  let document: JsonValue;
  try {
    document = parseJson(readFileSync(conversationPath, "utf8"));
  } catch {
    return EMPTY;
  }
  if (!isJsonObject(document) || !Array.isArray(document.messages)) return EMPTY;

  let model: string | undefined;
  let contextTokens = 0;
  let processedTokens = 0;
  const thoughts: GeminiThought[] = [];
  for (const message of document.messages) {
    if (!isJsonObject(message) || message.type !== "gemini") continue;
    model = asString(message.model) ?? model;
    const key = asString(message.id) ?? String(thoughts.length);
    if (Array.isArray(message.thoughts)) {
      message.thoughts.forEach((entry, index) => {
        const text = thoughtText(entry);
        if (text) thoughts.push({ id: `reasoning:${sessionKey}:${key}:${index}`, text });
      });
    }
    if (isJsonObject(message.tokens)) {
      // The newest exchange's prompt (plus cache) is the live context; totals
      // accumulate into the monotonic processed figure analytics charge.
      contextTokens = tokenNumber(message.tokens, "prompt") + tokenNumber(message.tokens, "cached");
      processedTokens += tokenNumber(message.tokens, "total");
    }
  }
  return { model, contextTokens, processedTokens, thoughts };
}
