import { describe, expect, test } from "bun:test";
import { canonicalRuntimeEvent, stableProgressEventId } from "./runtime-events";

describe("canonicalRuntimeEvent", () => {
  test("accepts a canonical request lifecycle event", () => {
    expect(
      canonicalRuntimeEvent({
        id: "event-1",
        agentId: "agent-1",
        type: "request.opened",
        createdAt: "2026-08-24T00:00:00.000Z",
        requestId: "request-1",
        payload: { kind: "approval" },
      }).type,
    ).toBe("request.opened");
  });

  test("rejects unknown lifecycle vocabulary", () => {
    expect(() =>
      canonicalRuntimeEvent({
        id: "1",
        agentId: "a",
        type: "sessionEnd",
        createdAt: new Date().toISOString(),
        payload: {},
      }),
    ).toThrow("Unknown runtime event type");
  });

  test("provides stable progress identities", () => {
    expect(stableProgressEventId("a", "tool-1")).toBe("activity:a:tool-1");
  });
});
