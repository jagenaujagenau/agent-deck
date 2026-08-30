import { describe, expect, test } from "bun:test";
import { SseParser } from "./sse";

describe("SseParser", () => {
  test("a frame split across chunks arrives once, whole", () => {
    const parser = new SseParser();
    expect(parser.push("event: snap")).toEqual([]);
    expect(parser.push('shot\nid: 4\ndata: {"a":')).toEqual([]);
    expect(parser.push("1}\n\n")).toEqual([{ event: "snapshot", id: "4", data: '{"a":1}' }]);
  });

  test("several frames in one chunk all come out, in order", () => {
    const parser = new SseParser();
    const frames = parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(frames.map((frame) => frame.event)).toEqual(["a", "b"]);
  });

  test("multi-line data joins with newlines, comments are skipped", () => {
    const parser = new SseParser();
    const frames = parser.push(": keepalive\ndata: one\ndata: two\n\n");
    expect(frames).toEqual([{ event: "message", id: undefined, data: "one\ntwo" }]);
  });

  test("a frame with no data is not a frame", () => {
    const parser = new SseParser();
    expect(parser.push("event: ping\n\n")).toEqual([]);
  });

  test("exactly one space after the colon is grammar, the rest is payload", () => {
    const parser = new SseParser();
    expect(parser.push("data:  padded\n\n")[0]?.data).toBe(" padded");
    expect(parser.push("data:tight\n\n")[0]?.data).toBe("tight");
  });
});
