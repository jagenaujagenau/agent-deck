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

  test("keeps a well-formed origin", () => {
    expect(
      canonicalRuntimeEvent({
        id: "event-2",
        agentId: "agent-1",
        type: "session.state.changed",
        createdAt: "2026-08-24T00:00:00.000Z",
        origin: { source: "claude-hooks", seq: 7 },
        payload: { state: "running" },
      }).origin,
    ).toEqual({ source: "claude-hooks", seq: 7 });
  });

  test("treats a malformed origin as absent rather than rejecting the event", () => {
    for (const origin of [
      "claude-hooks",
      { source: "claude-hooks" },
      { source: "", seq: 3 },
      { source: "claude-hooks", seq: "3" },
      { seq: 3 },
      null,
    ]) {
      const event = canonicalRuntimeEvent({
        id: "event-3",
        agentId: "agent-1",
        type: "session.state.changed",
        createdAt: "2026-08-24T00:00:00.000Z",
        origin,
        payload: { state: "running" },
      });
      expect(event.origin).toBeUndefined();
      expect(event.type).toBe("session.state.changed");
    }
  });

  test("leaves an absent origin absent", () => {
    expect(
      canonicalRuntimeEvent({
        id: "event-4",
        agentId: "agent-1",
        type: "session.state.changed",
        createdAt: "2026-08-24T00:00:00.000Z",
        payload: { state: "running" },
      }).origin,
    ).toBeUndefined();
  });

  test("provides stable progress identities", () => {
    expect(stableProgressEventId("a", "tool-1")).toBe("activity:a:tool-1");
  });
});
