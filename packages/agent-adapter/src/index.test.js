import { afterEach, describe, expect, test } from "bun:test";
import { AgentDeckClient } from "./index";
let server;
afterEach(() => server?.stop(true));
describe("AgentDeckClient", () => {
    test("authenticates and publishes normalized heartbeats", async () => {
        const captured = { authorization: null };
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
                    if (polls === 1)
                        return Response.json({ error: "restarting" }, { status: 503 });
                    return Response.json({ commands: polls < 3 ? [] : [{ id: "decision-1", action: "approve" }] });
                }
                if (url.pathname.endsWith("/ack"))
                    acknowledged = url.pathname;
                return Response.json({ ok: true });
            },
        });
        const client = new AgentDeckClient({ baseUrl: server.url.origin });
        expect(await client.waitForDecision("agent/1", { timeoutMs: 500, pollMs: 5 })).toBe(true);
        expect(acknowledged).toContain("agent%2F1/commands/decision-1/ack");
    });
});
