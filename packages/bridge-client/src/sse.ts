/**
 * An incremental Server-Sent Events parser: feed it chunks as they arrive,
 * collect complete frames. Pure so the frame grammar is testable without a
 * socket; the byte offsets and buffering are the only state.
 */

export interface SseFrame {
  event: string;
  id?: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  /** Consumes one chunk of the stream, returning every frame it completed. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // A frame ends at a blank line; a trailing fragment is a frame mid-write.
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame !== undefined) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // The SSE grammar strips exactly one space after the colon.
    const value = line.startsWith(" ", colon + 1) ? line.slice(colon + 2) : line.slice(colon + 1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, id, data: data.join("\n") };
}
