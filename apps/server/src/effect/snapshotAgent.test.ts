import { describe, expect, test } from "bun:test";
import { snapshotRateLimits, type SnapshotAgent } from "./State";

const heartbeatWindows = [{ id: "5h", label: "5-hour", usedPercent: 40 }];
const projectedWindows = [
  { id: "5h", label: "5-hour", usedPercent: 63, resetsAt: "2026-08-27T05:00:00.000Z" },
];

describe("snapshotRateLimits", () => {
  test("projected rate limits win when the runtime has reported them", () => {
    expect(snapshotRateLimits({ rateLimits: projectedWindows }, heartbeatWindows)).toEqual(
      projectedWindows,
    );
  });

  test("falls back to the heartbeat when the projection has never heard one", () => {
    expect(snapshotRateLimits({ rateLimits: undefined }, heartbeatWindows)).toEqual(
      heartbeatWindows,
    );
    expect(snapshotRateLimits(undefined, heartbeatWindows)).toEqual(heartbeatWindows);
  });

  test("a runtime that reported no open windows is believed", () => {
    // An empty report is a statement, not silence: every window closed.
    expect(snapshotRateLimits({ rateLimits: [] }, heartbeatWindows)).toEqual([]);
  });

  test("no source at all renders no rate limits", () => {
    expect(snapshotRateLimits(undefined, undefined)).toBeUndefined();
  });
});

describe("the snapshot agent", () => {
  test("carries the runtime the heartbeat declared", () => {
    // The phone and watch were guessing the harness from id prefixes on the
    // claim that the wire had no runtime field. It does: the snapshot agent
    // is the stored record spread whole, and the stored record keeps
    // `runtime` from the heartbeat.
    const agent: SnapshotAgent = {
      id: "agent-1",
      name: "Claude · fx",
      project: "fx",
      model: "claude",
      runtime: "claude",
      state: "idle",
      task: "Ready",
      tokens: 0,
      costUsd: 0,
      lastSeenAt: "2026-08-27T00:00:00.000Z",
      events: [],
    };
    expect(JSON.parse(JSON.stringify(agent)).runtime).toBe("claude");
  });
});
