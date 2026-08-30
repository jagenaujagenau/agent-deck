import { describe, expect, test } from "bun:test";
import { subscribeDeck } from "./stream";
import type { BridgeSnapshot, BridgeSnapshotPatch } from "./types";

/**
 * The live-deck subscription, driven through a scripted fetcher: one fake
 * connection per element, each serving its SSE frames and ending — which is
 * exactly a reconnect.
 */

const frame = (event: string, data: BridgeSnapshot | BridgeSnapshotPatch) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const snapshot = (sequence: number, task: string): BridgeSnapshot => ({
  sequence,
  bridge: { status: "connected", name: "test", timestamp: "2026-08-30T12:00:00Z" },
  summary: { active: 1, waiting: 0, errors: 0, tokens: 0, costUsd: 0 },
  agents: [
    {
      id: "a1",
      name: "Fixture",
      project: "deck",
      model: "test",
      state: "running",
      task,
      tokens: 0,
      costUsd: 0,
      lastSeenAt: "2026-08-30T12:00:00Z",
      events: [],
    },
  ],
});

const patch = (sequence: number, task: string) => {
  const { agents, bridge, summary } = snapshot(sequence, task);
  return { sequence, bridge, summary, agents, removed: [] };
};

/** Collects onSnapshot sequences until `count` arrive, then closes. */
const collect = (connections: string[], count: number) =>
  new Promise<Array<{ sequence: number; task: string }>>((resolve, reject) => {
    let served = 0;
    const seen: Array<{ sequence: number; task: string }> = [];
    const subscription = subscribeDeck("http://bridge.test", "token", {
      reconnectDelayMs: 1,
      // Bun's fetch type carries `preconnect` alongside the callable; the
      // scripted connection borrows the real one to satisfy it.
      fetcher: Object.assign(
        (_input: string | URL | Request, _init?: RequestInit) => {
          // A connection past the script serves an empty stream, which ends
          // and reconnects until the collector closes the subscription.
          const body = connections[served] ?? "";
          served += 1;
          return Promise.resolve(new Response(body, { status: 200 }));
        },
        { preconnect: fetch.preconnect },
      ),
      onSnapshot: (deck) => {
        seen.push({ sequence: deck.sequence, task: deck.agents[0]?.task ?? "" });
        if (seen.length === count) {
          subscription.close();
          resolve(seen);
        }
      },
    });
    setTimeout(() => {
      subscription.close();
      reject(new Error(`saw ${seen.length} of ${count}: ${JSON.stringify(seen)}`));
    }, 2_000);
  });

describe("subscribeDeck", () => {
  test("applies snapshots and patches in sequence order", async () => {
    const seen = await collect(
      [frame("snapshot", snapshot(5, "five")) + frame("patch", patch(6, "six"))],
      2,
    );
    expect(seen).toEqual([
      { sequence: 5, task: "five" },
      { sequence: 6, task: "six" },
    ]);
  });

  test("a stale patch is never applied over a newer deck", async () => {
    const seen = await collect(
      [
        frame("snapshot", snapshot(5, "five")) +
          frame("patch", patch(4, "stale")) +
          frame("patch", patch(6, "six")),
      ],
      2,
    );
    expect(seen.map((entry) => entry.sequence)).toEqual([5, 6]);
    expect(seen.some((entry) => entry.task === "stale")).toBe(false);
  });

  test("a reconnect replaying an older deck cannot roll the caller back", async () => {
    const seen = await collect(
      [
        frame("snapshot", snapshot(7, "seven")),
        // The next connection serves an older snapshot, then catches up.
        frame("snapshot", snapshot(3, "rollback")) + frame("snapshot", snapshot(8, "eight")),
      ],
      2,
    );
    expect(seen).toEqual([
      { sequence: 7, task: "seven" },
      { sequence: 8, task: "eight" },
    ]);
  });

  test("a patch against a rejected snapshot is dropped, not misapplied", async () => {
    const seen = await collect(
      [
        frame("snapshot", snapshot(7, "seven")),
        // Stale snapshot rejected; the patch riding behind it must not land
        // on the newer deck the caller already holds.
        frame("snapshot", snapshot(3, "rollback")) + frame("patch", patch(4, "stale-patch")),
        frame("snapshot", snapshot(9, "nine")),
      ],
      2,
    );
    expect(seen.map((entry) => entry.sequence)).toEqual([7, 9]);
  });
});
