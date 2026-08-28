import { asString, isJsonObject, isJsonString, parseJson } from "./json-value";
import type { JsonValue } from "./json-value";
import type { AssistantPart, TranscriptLine } from "./transcript-reasoning";

/**
 * Codex injects harness context as user-role response items — sandbox banners,
 * AGENTS.md contents, interruption markers. Nobody typed them, so a message
 * opening with one of these is plumbing, not conversation.
 */
const HARNESS_PREFIXES = [
  "<environment_context>",
  "<turn_aborted>",
  "<system_instruction>",
  "<user_instructions>",
  "<permissions instructions>",
  "<app-context>",
  "# AGENTS.md instructions",
];

/** The text of a message payload's content blocks, both directions of the wire. */
function contentText(content: JsonValue | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isJsonObject)
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

/**
 * One line of a Codex rollout (`~/.codex/sessions/`, any depth, `rollout-*.jsonl`), narrowed to the shape the
 * transcript tail consumes. Every line is `{timestamp, type, payload}`; the conversation lives in
 * `response_item` payloads — `message` items with user or assistant roles, and `reasoning` items.
 * Everything else — `event_msg` (which duplicates the same turns as UI events), `turn_context`,
 * `session_meta`, `compacted`, tool calls and their outputs — is not conversation.
 *
 * Reasoning content itself ships encrypted; what a rollout keeps in the clear is the summary,
 * so each `summary_text` becomes one thinking part and an unsummarised item is nothing at all.
 */
export function parseCodexTranscriptLine(line: string): TranscriptLine {
  let entry: JsonValue;
  try {
    entry = parseJson(line);
  } catch {
    return { kind: "other" };
  }
  if (!isJsonObject(entry) || entry.type !== "response_item" || !isJsonObject(entry.payload)) {
    return { kind: "other" };
  }
  const payload = entry.payload;
  // Only some rollout items carry their own OpenAI id ("rs_…"); the reader falls
  // back to the line's byte offset for the rest, which is just as stable.
  const key = asString(payload.id);
  if (payload.type === "reasoning") {
    const parts: AssistantPart[] = Array.isArray(payload.summary)
      ? payload.summary
          .filter(isJsonObject)
          .filter((part) => part.type === "summary_text" && isJsonString(part.text))
          .map((part) => ({ thinking: String(part.text) }))
      : [];
    if (!parts.length) return { kind: "other" };
    return { kind: "assistant", key, parts };
  }
  if (payload.type !== "message") return { kind: "other" };
  const text = contentText(payload.content);
  if (payload.role === "assistant") {
    return { kind: "assistant", key, parts: [{ text }] };
  }
  if (payload.role === "user") {
    if (HARNESS_PREFIXES.some((prefix) => text.startsWith(prefix))) return { kind: "other" };
    return { kind: "user", key, text };
  }
  // Developer-role items are harness instructions, never the person.
  return { kind: "other" };
}
