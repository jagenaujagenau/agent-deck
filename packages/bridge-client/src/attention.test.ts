import { describe, expect, test } from "bun:test";
import { attentionPriority, latestActivityAt, sessionSeen } from "./attention";
import type { Agent } from "./types";

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "a",
  name: "a",
  project: "p",
  model: "m",
  state: "idle",
  task: "t",
  tokens: 0,
  costUsd: 0,
  lastSeenAt: "2026-08-28T10:00:00.000Z",
  events: [],
  ...overrides,
});

describe("attentionPriority", () => {
  test("the stuck one is always first, done-unseen outranks running", () => {
    const ranks = [
      attentionPriority("error", false, false),
      attentionPriority("running", true, false),
      attentionPriority("idle", false, false),
      attentionPriority("running", false, false),
      attentionPriority("idle", false, true),
      attentionPriority("offline", false, true),
    ];
    expect(ranks).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

describe("sessionSeen", () => {
  test("a local mark covering the latest activity counts as seen", () => {
    expect(sessionSeen(agent(), "2026-08-28T10:00:00.000Z")).toBe(true);
  });

  test("the bridge's viewedAt counts too — a glance anywhere clears everywhere", () => {
    expect(sessionSeen(agent({ viewedAt: "2026-08-28T10:00:01.000Z" }))).toBe(true);
  });

  test("neither mark survives newer activity", () => {
    const busy = agent({
      viewedAt: "2026-08-28T10:00:01.000Z",
      events: [
        { id: "e", kind: "output", summary: "Response", createdAt: "2026-08-28T10:00:05.000Z" },
      ],
    });
    expect(sessionSeen(busy, "2026-08-28T10:00:02.000Z")).toBe(false);
    expect(latestActivityAt(busy)).toBe("2026-08-28T10:00:05.000Z");
  });

  test("no marks at all is unseen", () => {
    expect(sessionSeen(agent())).toBe(false);
  });
});
