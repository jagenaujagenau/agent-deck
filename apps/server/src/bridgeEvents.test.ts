import { describe, expect, test } from "bun:test";
import { mergeRecentEvents } from "./bridgeEvents";

describe("mergeRecentEvents", () => {
  test("deduplicates compatibility heartbeat replay by stable event id", () => {
    const response = { id: "response", createdAt: "2026-08-24T10:00:00Z", kind: "output" };
    const tool = { id: "tool", createdAt: "2026-08-24T10:01:00Z", kind: "tool" };
    const merged = mergeRecentEvents([response, tool], [tool, tool]);
    expect(merged.map((event) => event.id)).toEqual(["response", "tool"]);
  });

  test("keeps the newest bounded history", () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      createdAt: `2026-08-24T10:00:0${index}Z`,
    }));
    expect(mergeRecentEvents([], events, 3).map((event) => event.id)).toEqual(["3", "4", "5"]);
  });
});
