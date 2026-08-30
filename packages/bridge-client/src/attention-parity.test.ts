import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attentionPriority, sessionSeen } from "./attention";
import type { Agent } from "./types";

/**
 * The golden fixture, executed against the TypeScript implementation.
 *
 * The same corpus drives AttentionRank.kt (JVM test) and AttentionPolicy.swift
 * + SeenPolicy.swift (swift test), so three languages answering differently is
 * a failing build instead of a drifting comment.
 */

type RankCase = { case: string; state: string; blocked: boolean; seen: boolean; expect: number };
type SeenCase = {
  case: string;
  lastSeenAt: string;
  eventAts: string[];
  viewedAt: string | null;
  localSeenAt: string | null;
  expect: boolean;
};

const fixturePath = join(import.meta.dir, "..", "fixtures", "attention-parity.json");
// SAFETY: the fixture is this repo's own checked-in corpus; the three parity
// suites are what hold it to this shape.
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  rank: RankCase[];
  seen: SeenCase[];
};

const agentFor = (entry: SeenCase): Agent => ({
  id: "a1",
  name: "Fixture",
  project: "parity",
  model: "test",
  state: "idle",
  task: "",
  tokens: 0,
  costUsd: 0,
  lastSeenAt: entry.lastSeenAt,
  viewedAt: entry.viewedAt ?? undefined,
  events: entry.eventAts.map((createdAt, index) => ({
    id: `e${index}`,
    kind: "output",
    summary: "",
    createdAt,
  })),
});

describe("attention parity fixture", () => {
  test("the corpus is not empty", () => {
    expect(fixture.rank.length).toBeGreaterThan(0);
    expect(fixture.seen.length).toBeGreaterThan(0);
  });

  for (const entry of fixture.rank) {
    test(`rank: ${entry.case}`, () => {
      expect(attentionPriority(entry.state, entry.blocked, entry.seen)).toBe(entry.expect);
    });
  }

  for (const entry of fixture.seen) {
    test(`seen: ${entry.case}`, () => {
      expect(sessionSeen(agentFor(entry), entry.localSeenAt ?? undefined)).toBe(entry.expect);
    });
  }
});
