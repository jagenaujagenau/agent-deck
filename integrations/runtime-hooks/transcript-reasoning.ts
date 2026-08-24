import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Never flood the bridge's bounded event history from one pass. */
const MAX_PER_PASS = 20;

export type ReasoningBlock = { id: string; text: string };
export type TranscriptMessage = { id: string; role: "user" | "assistant"; text: string };
export type TranscriptCursor = { offset?: number };

/**
 * Reads thinking blocks written to a session transcript since `cursor.offset`, advancing it past
 * the lines consumed.
 *
 * Claude Code exposes no thinking hook, so the transcript is the only place its reasoning appears.
 * The first pass seeds the cursor at the current end of file and returns nothing: replaying a long
 * session's whole backlog at once would evict its other activity from the bridge's history.
 */
export function readNewReasoning(transcriptPath: string, cursor: TranscriptCursor, sessionKey: string): ReasoningBlock[] {
  return readNewTranscript(transcriptPath, cursor, sessionKey).reasoning;
}

/**
 * The session's conversation as the terminal shows it. The bridge only ever sees what hooks publish
 * — which starts when Agent Deck is installed and omits anything a hook does not report — so the
 * transcript is the only way for the app's chat to match the local one.
 *
 * Conversational turns number in the dozens, not thousands, so the whole file is worth one pass.
 */
export function readConversationBacklog(transcriptPath: string, sessionKey: string): TranscriptMessage[] {
  let size: number;
  try { size = statSync(transcriptPath).size; } catch { return []; }
  return readNewTranscript(transcriptPath, { offset: 0 }, sessionKey, size).messages;
}

export function readNewTranscript(transcriptPath: string, cursor: TranscriptCursor, sessionKey: string, forcedSize?: number): { reasoning: ReasoningBlock[]; messages: TranscriptMessage[] } {
  const empty = { reasoning: [] as ReasoningBlock[], messages: [] as TranscriptMessage[] };
  let size: number;
  if (forcedSize !== undefined) size = forcedSize;
  else { try { size = statSync(transcriptPath).size; } catch { return empty; } }

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
  try { handle = openSync(transcriptPath, "r"); } catch { return empty; }
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
  cursor.offset = previous + complete.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);

  const blocks: ReasoningBlock[] = [];
  const messages: TranscriptMessage[] = [];
  for (const line of complete) {
    if (!line.trim()) continue;
    let entry: { type?: string; uuid?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isMeta) continue;
    const key = entry.uuid ?? `${cursor.offset}`;
    if (entry.type === "user") {
      // A user entry is either something the person typed, or a tool result being fed back. Only
      // the former belongs in a conversation.
      const content = entry.message?.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((part) => (part as { type?: string }).type === "text").map((part) => String((part as { text?: unknown }).text ?? "")).join("\n")
          : "";
      if (text.trim()) messages.push({ id: `chat:${sessionKey}:${key}`, role: "user", text: text.trim() });
      continue;
    }
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const spoken: string[] = [];
    entry.message.content.forEach((block, index) => {
      const part = block as { type?: string; thinking?: unknown; text?: unknown };
      if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
        blocks.push({ id: `reasoning:${sessionKey}:${key}:${index}`, text: part.thinking });
      }
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) spoken.push(part.text);
    });
    if (spoken.length) messages.push({ id: `chat:${sessionKey}:${key}`, role: "assistant", text: spoken.join("\n\n").trim() });
  }
  return { reasoning: blocks.slice(-MAX_PER_PASS), messages };
}
