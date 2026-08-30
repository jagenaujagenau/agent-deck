import { afterAll, describe, expect, test } from "bun:test";
import { AgentBlockedError, BridgeClient, BridgeError } from "./client";
import { subscribeDeck } from "./stream";
import type { BridgeSnapshot } from "./types";

/**
 * A stub speaking the wire contract's frames and refusals, so the client and
 * the stream are exercised over real HTTP rather than mocked fetch plumbing.
 */
const deck: BridgeSnapshot = {
  sequence: 1,
  bridge: { status: "ok", name: "stub", timestamp: "2026-08-28T10:00:00.000Z" },
  summary: { active: 1, waiting: 0, errors: 0, tokens: 10, costUsd: 0.1 },
  agents: [
    {
      id: "claude-1",
      name: "Claude · demo",
      project: "demo",
      model: "m",
      state: "running",
      task: "working",
      tokens: 10,
      costUsd: 0.1,
      lastSeenAt: "2026-08-28T10:00:00.000Z",
      events: [],
    },
  ],
};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const authorized = request.headers.get("authorization") === "Bearer good";
    if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });

    if (url.pathname === "/bridge/v1/snapshot") return Response.json(deck);
    if (url.pathname === "/bridge/v1/agents/claude-1/history") {
      return Response.json({
        events: [
          {
            id: "e1",
            kind: "user",
            summary: "Message",
            detail: "hi",
            createdAt: "2026-08-28T10:00:01.000Z",
          },
        ],
      });
    }
    if (url.pathname === "/bridge/v1/agents/claude-1/control") {
      // SAFETY: the test's own client sends exactly this shape.
      const body = (await request.json()) as { action: string; force?: boolean };
      if (body.action === "prompt" && body.force !== true) {
        return Response.json(
          { error: "agent_blocked", detail: "The agent is waiting for approval to run Bash" },
          { status: 409 },
        );
      }
      return Response.json(
        {
          id: "cmd-1",
          agentId: "claude-1",
          action: body.action,
          createdAt: "2026-08-28T10:00:02.000Z",
        },
        { status: 202 },
      );
    }
    if (url.pathname === "/bridge/v1/agents/claude-1/seen") {
      return Response.json({ viewedAt: "2026-08-28T10:00:03.000Z" });
    }
    if (url.pathname === "/bridge/v1/events") {
      const changed = { ...deck.agents[0]!, task: "still working" };
      const frames =
        `event: snapshot\nid: 1\ndata: ${JSON.stringify(deck)}\n\n` +
        `event: ping\ndata: 1\n\n` +
        `event: patch\nid: 2\ndata: ${JSON.stringify({
          sequence: 2,
          bridge: deck.bridge,
          summary: deck.summary,
          agents: [changed],
          removed: [],
        })}\n\n`;
      return new Response(frames, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

describe("BridgeClient", () => {
  test("reads with the token, and a refusal names its status", async () => {
    const client = new BridgeClient(base, "good");
    expect((await client.snapshot()).agents[0]?.id).toBe("claude-1");
    expect((await client.history("claude-1", 10))[0]?.detail).toBe("hi");

    const unauthorized = new BridgeClient(base, "bad");
    await expect(unauthorized.snapshot()).rejects.toBeInstanceOf(BridgeError);
  });

  test("a prompt to a blocked session throws the bridge's own sentence; force queues", async () => {
    const client = new BridgeClient(base, "good");
    await expect(client.control("claude-1", "prompt", "hello")).rejects.toThrow(
      "The agent is waiting for approval to run Bash",
    );
    await expect(client.control("claude-1", "prompt", "hello")).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
    const queued = await client.control("claude-1", "prompt", "hello", { force: true });
    expect(queued.id).toBe("cmd-1");
  });

  test("marking seen returns the shared viewedAt", async () => {
    const client = new BridgeClient(base, "good");
    expect(await client.markSeen("claude-1")).toBe("2026-08-28T10:00:03.000Z");
  });
});

describe("subscribeDeck", () => {
  test("delivers the snapshot, applies the patch, ignores pings", async () => {
    const seen: BridgeSnapshot[] = [];
    const subscription = subscribeDeck(base, "good", {
      onSnapshot: (snapshot) => seen.push(snapshot),
      // The stub closes its stream after the frames; reconnecting would
      // replay them forever, so park the retry far beyond the test.
      reconnectDelayMs: 60_000,
    });
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    subscription.close();

    expect(seen).toHaveLength(2);
    expect(seen[0]?.sequence).toBe(1);
    expect(seen[1]?.sequence).toBe(2);
    expect(seen[1]?.agents[0]?.task).toBe("still working");
  });
});
