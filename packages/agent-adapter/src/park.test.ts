import { describe, expect, test } from "bun:test";
import { AgentDeckClient } from "./client";

/**
 * The parked waits, driven without a bridge or a wall clock.
 *
 * A runtime blocked on an approval holds a request open for up to 25 seconds
 * and then sleeps before asking again. Against global `fetch` and global
 * `setTimeout` that could only be exercised by a real socket and real
 * elapsed time — which is why the fake-harness e2e spawns a process per hook
 * beat instead of driving the handler in process. With the transport and the
 * sleep injected, the answer arrives on the test's own schedule.
 */

/** A bridge that answers each poll from a script, recording what it was asked. */
const scriptedBridge = (replies: ReadonlyArray<unknown>) => {
  const asked: string[] = [];
  const slept: number[] = [];
  let poll = 0;
  const client = new AgentDeckClient({
    baseUrl: "http://bridge.test",
    token: "t",
    transport: async (input) => {
      asked.push(String(input));
      const body = replies[Math.min(poll++, replies.length - 1)];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    // Time passes when the client says it does, and not otherwise.
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { client, asked, slept };
};

describe("waiting for an answer", () => {
  test("an answered request ends the wait with the words chosen", async () => {
    const { client, asked } = scriptedBridge([{ status: "answered", value: { "Which?": "main" } }]);
    expect(await client.waitForAnswer("a1", "r1")).toBe("main");
    // Parked on the bridge: the wait window rides the request itself rather
    // than being spent polling.
    expect(asked[0]).toContain("/agents/a1/requests/r1?wait=25");
    expect(asked).toHaveLength(1);
  });

  test("a pending request is asked again after the pause", async () => {
    const { client, asked, slept } = scriptedBridge([
      { status: "pending" },
      { status: "pending" },
      { status: "answered", value: "opus" },
    ]);
    expect(await client.waitForAnswer("a1", "r1", { pollMs: 250 })).toBe("opus");
    expect(asked).toHaveLength(3);
    // The pause exists so a bridge that ignores `wait` cannot spin the loop.
    expect(slept).toEqual([250, 250]);
  });

  test("a request that settled another way ends the wait with nothing", async () => {
    const { client } = scriptedBridge([{ status: "expired" }]);
    // Expired is an answer about the request, not an answer to it.
    expect(await client.waitForAnswer("a1", "r1")).toBeUndefined();
  });

  test("the deadline ends a wait nobody ever answers", async () => {
    const { client, asked } = scriptedBridge([{ status: "pending" }]);
    // A deadline already past: the loop must not run at all.
    expect(await client.waitForAnswer("a1", "r1", { timeoutMs: -1 })).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("a bridge that cannot be reached is transient, not fatal", async () => {
    let attempt = 0;
    const client = new AgentDeckClient({
      baseUrl: "http://bridge.test",
      token: "t",
      transport: async () => {
        attempt += 1;
        // The bridge restarting while a runtime is blocked on an answer: the
        // wait rides it out rather than failing the tool call.
        if (attempt === 1) throw new Error("connection refused");
        return new Response(JSON.stringify({ status: "answered", value: "yes" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      sleep: async () => {},
    });
    expect(await client.waitForAnswer("a1", "r1")).toBe("yes");
    expect(attempt).toBe(2);
  });
});

describe("waiting for a decision", () => {
  test("an approval is released the moment the decision lands", async () => {
    const { client, asked } = scriptedBridge([
      { commands: [] },
      { commands: [{ id: "c1", action: "approve", createdAt: "2026-08-31T12:00:00Z" }] },
    ]);
    expect(await client.waitForDecision("a1", { pollMs: 10 })).toBe(true);
    // Two polls, then the acknowledgement: the decision is collected before
    // the tool call is released, so a redelivery cannot answer it twice.
    expect(asked).toHaveLength(3);
    expect(asked.at(-1)).toContain("/commands/c1/ack");
  });

  test("a rejection is a decision too", async () => {
    const { client } = scriptedBridge([
      { commands: [{ id: "c1", action: "reject", createdAt: "2026-08-31T12:00:00Z" }] },
    ]);
    expect(await client.waitForDecision("a1")).toBe(false);
  });
});
