import { afterEach, describe, expect, test } from "bun:test";
import { AgentDeckClient, clipMultiline } from "./index";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

describe("clipMultiline", () => {
  test("preserves Markdown table rows", () => {
    const markdown = "| Before | After |\n|---|---|\n| Old | New |";
    expect(clipMultiline(markdown)).toBe(markdown);
  });

  test("does not truncate normal long-form responses at the old event limit", () => {
    const response = `${"paragraph\n\n".repeat(300)}finished`;
    expect(response.length).toBeGreaterThan(2_000);
    expect(clipMultiline(response)).toBe(response);
  });
});

describe("AgentDeckClient", () => {
  test("authenticates and publishes normalized heartbeats", async () => {
    const captured: { authorization: string | null; body?: unknown } = { authorization: null };
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        captured.authorization = request.headers.get("authorization");
        captured.body = await request.json();
        return Response.json({ ok: true });
      },
    });
    const client = new AgentDeckClient({ baseUrl: server.url.origin, token: "secret" });
    await client.heartbeat({ id: "claude-1", name: "Claude", project: "deck", model: "opus", state: "running", task: "Testing" });
    expect(captured.authorization).toBe("Bearer secret");
    expect(captured.body).toMatchObject({ id: "claude-1", tokens: 0, costUsd: 0 });
  });

  test("waits for and acknowledges an approval decision", async () => {
    let polls = 0;
    let acknowledged = "";
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/commands")) {
          polls += 1;
          if (polls === 1) return Response.json({ error: "restarting" }, { status: 503 });
          return Response.json({ commands: polls < 3 ? [] : [{ id: "decision-1", action: "approve" }] });
        }
        if (url.pathname.endsWith("/ack")) acknowledged = url.pathname;
        return Response.json({ ok: true });
      },
    });
    const client = new AgentDeckClient({ baseUrl: server.url.origin });
    expect(await client.waitForDecision("agent/1", { timeoutMs: 500, pollMs: 5 })).toBe(true);
    expect(acknowledged).toContain("agent%2F1/commands/decision-1/ack");
  });
});
