import { describe, expect, test } from "bun:test";
import { applyPatch } from "./patch";
import type { Agent, BridgeSnapshot, BridgeSnapshotPatch } from "./types";

const agent = (id: string, task = "t"): Agent => ({
  id,
  name: id,
  project: "p",
  model: "m",
  state: "running",
  task,
  tokens: 0,
  costUsd: 0,
  lastSeenAt: "2026-08-28T10:00:00.000Z",
  events: [],
});

const deck = (...agents: Agent[]): BridgeSnapshot => ({
  sequence: 1,
  bridge: { status: "ok", name: "b", timestamp: "2026-08-28T10:00:00.000Z" },
  summary: { active: agents.length, waiting: 0, errors: 0, tokens: 0, costUsd: 0 },
  agents,
});

const patch = (agents: Agent[], removed: string[] = []): BridgeSnapshotPatch => ({
  ...deck(...agents),
  sequence: 2,
  removed,
});

describe("applyPatch", () => {
  test("a changed agent is replaced in place, order preserved", () => {
    const next = applyPatch(deck(agent("a"), agent("b")), patch([agent("a", "changed")]));
    expect(next.agents.map((item) => item.id)).toEqual(["a", "b"]);
    expect(next.agents[0]?.task).toBe("changed");
    expect(next.sequence).toBe(2);
  });

  test("agents absent from the patch are carried over unchanged", () => {
    const next = applyPatch(deck(agent("a"), agent("b")), patch([agent("b", "busy")]));
    expect(next.agents[0]?.task).toBe("t");
    expect(next.agents[1]?.task).toBe("busy");
  });

  test("removed ids drop, new agents append", () => {
    const next = applyPatch(deck(agent("a"), agent("b")), patch([agent("c")], ["a"]));
    expect(next.agents.map((item) => item.id)).toEqual(["b", "c"]);
  });
});
