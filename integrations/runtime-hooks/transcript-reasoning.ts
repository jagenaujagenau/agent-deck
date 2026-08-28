import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseCodexTranscriptLine } from "./codex-transcript";
import { asString, isJsonObject, isJsonString, parseJson } from "./json-value";
import type { JsonValue } from "./json-value";
import { parseTaskNotification } from "./task-notification";

/** Never flood the bridge's bounded event history from one pass. */
const MAX_PER_PASS = 20;

/** Which runtime wrote the transcript, and therefore which line grammar to read it with. */
export type TranscriptRuntime = "claude" | "codex";

export type ReasoningBlock = { id: string; text: string };
export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** What the card should call this, where the runtime named it better than "Response". */
  summary?: string;
};
export type TranscriptCursor = { offset?: number };
/**
 * A Task call answered with the child's identity. The tool result names both
 * the subagent's id and what it was asked to do, which is the only place those
 * two facts meet — hook events from inside the run carry the id and a generic
 * type ("general-purpose"), never the errand.
 */
export type SubagentSpawn = { id: string; subagentId: string; name: string };
export type TranscriptRead = {
  reasoning: ReasoningBlock[];
  messages: TranscriptMessage[];
  spawns: SubagentSpawn[];
};

/**
 * One transcript line, narrowed at the read to the three shapes the tail cares
 * about. The transcript is the runtime's own file, so anything else — meta
 * entries, tool traffic, half-parsed lines — is simply not part of the
 * conversation.
 */
export type TranscriptLine =
  | { kind: "user"; key?: string; text: string; spawn?: { subagentId: string; name: string } }
  | { kind: "assistant"; key?: string; parts: AssistantPart[] }
  | { kind: "other" };

/** A block of an assistant turn, kept in its original position so ids keep their index. */
export type AssistantPart = { thinking?: string; text?: string };

function assistantPart(block: JsonValue): AssistantPart {
  const part: AssistantPart = {};
  if (isJsonObject(block)) {
    if (block.type === "thinking" && isJsonString(block.thinking)) part.thinking = block.thinking;
    if (block.type === "text" && isJsonString(block.text)) part.text = block.text;
  }
  return part;
}

function parseTranscriptLine(line: string): TranscriptLine {
  let entry: JsonValue;
  try {
    entry = parseJson(line);
  } catch {
    return { kind: "other" };
  }
  if (!isJsonObject(entry) || entry.isMeta) return { kind: "other" };
  const key = asString(entry.uuid);
  const message = isJsonObject(entry.message) ? entry.message : undefined;
  if (entry.type === "user") {
    const content = message?.content;
    const text = isJsonString(content)
      ? content
      : Array.isArray(content)
        ? content
            .filter(isJsonObject)
            .filter((part) => part.type === "text")
            .map((part) => String(part.text ?? ""))
            .join("\n")
        : "";
    const parsed: TranscriptLine = { kind: "user", key, text };
    // A Task tool's result entry carries `toolUseResult` with the child's id
    // and the description the Task call gave it.
    const result = entry.toolUseResult;
    if (isJsonObject(result)) {
      const subagentId = asString(result.agentId);
      const name = asString(result.description);
      if (subagentId && name) parsed.spawn = { subagentId, name };
    }
    return parsed;
  }
  if (entry.type === "assistant" && Array.isArray(message?.content)) {
    return { kind: "assistant", key, parts: message.content.map(assistantPart) };
  }
  return { kind: "other" };
}

/**
 * Reads thinking blocks written to a session transcript since `cursor.offset`, advancing it past
 * the lines consumed.
 *
 * Claude Code exposes no thinking hook, so the transcript is the only place its reasoning appears.
 * The first pass seeds the cursor at the current end of file and returns nothing: replaying a long
 * session's whole backlog at once would evict its other activity from the bridge's history.
 */
export function readNewReasoning(
  transcriptPath: string,
  cursor: TranscriptCursor,
  sessionKey: string,
  runtime: TranscriptRuntime = "claude",
): ReasoningBlock[] {
  return readNewTranscript(transcriptPath, cursor, sessionKey, runtime).reasoning;
}

/**
 * The session's conversation as the terminal shows it. The bridge only ever sees what hooks publish
 * — which starts when Agent Deck is installed and omits anything a hook does not report — so the
 * transcript is the only way for the app's chat to match the local one.
 *
 * Conversational turns number in the dozens, not thousands, so the whole file is worth one pass.
 */
export function readConversationBacklog(
  transcriptPath: string,
  sessionKey: string,
  runtime: TranscriptRuntime = "claude",
): Pick<TranscriptRead, "messages" | "spawns"> {
  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return { messages: [], spawns: [] };
  }
  const { messages, spawns } = readNewTranscript(
    transcriptPath,
    { offset: 0 },
    sessionKey,
    runtime,
    size,
    Number.POSITIVE_INFINITY,
  );
  // Reasoning is deliberately not part of a backlog: replaying a long
  // session's every thought at once would evict its other activity from the
  // bridge's bounded history.
  return { messages, spawns };
}

export function readNewTranscript(
  transcriptPath: string,
  cursor: TranscriptCursor,
  sessionKey: string,
  runtime: TranscriptRuntime = "claude",
  forcedSize?: number,
  /**
   * How much reasoning one pass will take before leaving the rest for the next.
   * The backlog read lifts it, because a limit meant to pace a live tail would
   * otherwise cut a whole conversation short.
   */
  reasoningLimit: number = MAX_PER_PASS,
): TranscriptRead {
  const empty: TranscriptRead = { reasoning: [], messages: [], spawns: [] };
  let size: number;
  if (forcedSize !== undefined) size = forcedSize;
  else {
    try {
      size = statSync(transcriptPath).size;
    } catch {
      return empty;
    }
  }

  const previous = cursor.offset;
  if (previous === undefined || previous > size) {
    // First sight of this transcript, or it was truncated or replaced by a resume or fork.
    cursor.offset = size;
    return empty;
  }
  if (previous === size) return empty;

  // Read only the new bytes, and read them as bytes: the offset is a byte count, while slicing a
  // decoded string would cut on UTF-16 units and desynchronise on the first non-ASCII character.
  let chunk: string;
  let handle: number;
  try {
    handle = openSync(transcriptPath, "r");
  } catch {
    return empty;
  }
  try {
    const buffer = Buffer.allocUnsafe(size - previous);
    const read = readSync(handle, buffer, 0, buffer.length, previous);
    chunk = buffer.subarray(0, read).toString("utf8");
  } catch {
    return empty;
  } finally {
    closeSync(handle);
  }

  const lines = chunk.split("\n");
  // A trailing fragment means the runtime is mid-write; leave it for the next pass.
  const complete = chunk.endsWith("\n") ? lines : lines.slice(0, -1);

  const blocks: ReasoningBlock[] = [];
  const messages: TranscriptMessage[] = [];
  const spawns: SubagentSpawn[] = [];
  // The cursor advances line by line rather than in one jump to the end. A pass
  // stops once it has enough reasoning, and stopping must leave the rest to be
  // read next time: advancing past lines this pass declined to publish is how
  // reasoning goes missing for good. That matters after any gap - a daemon
  // restart, a sleeping machine - where one catch-up pass covers a whole turn.
  let consumed = previous;
  for (const line of complete) {
    if (blocks.length >= reasoningLimit) break;
    const lineStart = consumed;
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    const entry =
      runtime === "codex" ? parseCodexTranscriptLine(line) : parseTranscriptLine(line);
    if (entry.kind === "other") continue;
    // Claude lines always carry a uuid; Codex rollout items mostly don't, so a
    // keyless one is named by where its bytes start, which re-reads reproduce.
    const key = entry.key ?? `${lineStart}`;
    if (entry.kind === "user") {
      // A tool result that answered a Task call is where a subagent's id and
      // its errand meet; every one is worth a naming event before the text
      // check below discards the entry as conversation.
      if (entry.spawn)
        spawns.push({
          id: `subagent-named:${sessionKey}:${entry.spawn.subagentId}`,
          subagentId: entry.spawn.subagentId,
          name: entry.spawn.name,
        });
      // A user entry is either something the person typed, or a tool result being fed back. Only
      // the former belongs in a conversation.
      const text = entry.text;
      if (!text.trim()) continue;
      // ...or a third thing the dichotomy above missed: the harness reporting a
      // background agent back to the model, injected as a user turn because
      // that is the only shape it has to inject one in. Nobody typed it, so it
      // is published as what it is — the agent speaking — with the plumbing off.
      const notification = parseTaskNotification(text);
      messages.push(
        notification
          ? {
              id: `chat:${sessionKey}:${key}`,
              role: "assistant",
              text: notification.result,
              summary: notification.summary,
            }
          : { id: `chat:${sessionKey}:${key}`, role: "user", text: text.trim() },
      );
      continue;
    }
    const spoken: string[] = [];
    entry.parts.forEach((part, index) => {
      if (part.thinking !== undefined && part.thinking.trim()) {
        blocks.push({ id: `reasoning:${sessionKey}:${key}:${index}`, text: part.thinking });
      }
      if (part.text !== undefined && part.text.trim()) spoken.push(part.text);
    });
    if (spoken.length)
      messages.push({
        id: `chat:${sessionKey}:${key}`,
        role: "assistant",
        text: spoken.join("\n\n").trim(),
      });
  }
  cursor.offset = consumed;
  return { reasoning: blocks, messages, spawns };
}
