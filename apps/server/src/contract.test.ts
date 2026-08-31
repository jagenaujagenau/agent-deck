import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBlockedError,
  BridgeClient,
  BridgeError,
  mergeSessionEvents,
  subscribeDeck,
} from "@agent-control-dashboard/bridge-client";
import type { BridgeSnapshot } from "@agent-control-dashboard/bridge-client";

/**
 * The wire contract (docs/bridge-api.md), executed.
 *
 * A real bridge subprocess on a scratch database, driven through the consumer
 * SDK exactly as a stranger's client would drive it. When this file and the
 * contract document disagree, one of them is lying — and this one runs.
 */

const MASTER = "contract-master-token";
const at = new Date().toISOString();

let port = 0;
let base = "";
let pairingCode = "";
let databaseUrl = "";
let bridge: Bun.Subprocess<"ignore", "pipe", "pipe">;
let master: BridgeClient;

/** One bridge subprocess on the suite's port and database — restartable. */
const spawnBridge = () =>
  Bun.spawn(["bun", "src/effect/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      BRIDGE_REQUIRE_AUTH: "true",
      BRIDGE_TOKEN: MASTER,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

const waitAlive = async () => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const alive = await fetch(`${base}/`);
      if (alive.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("bridge did not come up in 15s");
    await Bun.sleep(100);
  }
};

/** What an adapter puts on the wire: JSON, shaped by the route it is aimed at. */
type WireValue = string | number | boolean | null | ReadonlyArray<WireValue> | WirePayload;
type WirePayload = { [key: string]: WireValue };

/** Publishes as an adapter would: the master credential and the raw routes. */
const publish = async (path: string, body: WirePayload) => {
  const response = await fetch(`${base}/bridge/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // SAFETY: bridge responses are JSON; the tests assert the documented shapes,
  // and a mismatch is exactly the finding this suite exists to produce.
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as WirePayload };
};

const heartbeat = (id: string, overrides: WirePayload = {}) =>
  publish("/agents/heartbeat", {
    id,
    name: `Contract · ${id}`,
    project: "contract",
    model: "test-model",
    state: "running",
    task: "under test",
    tokens: 10,
    costUsd: 0.01,
    runtime: "codex",
    ...overrides,
  });

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port!;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;

  databaseUrl = `file:${join(mkdtempSync(join(tmpdir(), "bridge-contract-")), "contract.db")}`;
  bridge = spawnBridge();

  // The pairing code is issued once at startup and printed, which is the only
  // place a device ever learns it.
  const logged = (async () => {
    let seen = "";
    for await (const chunk of bridge.stdout) {
      seen += new TextDecoder().decode(chunk);
      const match = /Pairing code: (\d{6})/.exec(seen);
      if (match) return match[1]!;
    }
    throw new Error(`bridge exited before printing a pairing code:\n${seen}`);
  })();

  await waitAlive();
  pairingCode = await logged;
  master = new BridgeClient(base, MASTER);
});

afterAll(() => {
  bridge?.kill();
});

describe("the wire contract, executed", () => {
  test("the root answers liveness to anyone; the API answers 401 without a credential", async () => {
    const root = await fetch(`${base}/`);
    // SAFETY: the contract documents this exact shape; the assertion checks it.
    const body = (await root.json()) as { status: string; name: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.name).toBe("agent-deck-bridge");
    expect(body.version).not.toBe("");

    const bare = await fetch(`${base}/bridge/v1/snapshot`);
    expect(bare.status).toBe(401);
  });

  test("pairing mints a device token; the code is single-use", async () => {
    const device = new BridgeClient(base);
    const paired = await device.pair(pairingCode, "Contract suite");
    expect(paired.token).not.toBe("");

    const snapshot = await device.snapshot();
    expect(snapshot.bridge.status).toBe("connected");

    const again = new BridgeClient(base);
    await expect(again.pair(pairingCode, "Second device")).rejects.toBeInstanceOf(BridgeError);
  });

  test("a heartbeat makes a session, and the wire names its runtime", async () => {
    const { status } = await heartbeat("codex-contract-1");
    expect(status).toBe(201);
    const agent = await master.agent("codex-contract-1");
    expect(agent?.runtime).toBe("codex");
    expect(agent?.state).toBe("running");
  });

  test("the snapshot strips command and diff; history restores them through the merge", async () => {
    await heartbeat("codex-contract-1");
    const longDetail = `heredoc payload ${"x".repeat(600)}`;
    await publish("/agents/codex-contract-1/events", {
      kind: "tool",
      summary: "Bash",
      detail: longDetail,
      command: "bun test --cwd apps/server",
      id: "contract-terminal-1",
    });

    const agent = (await master.agent("codex-contract-1"))!;
    const live = agent.events.find((event) => event.id === "contract-terminal-1")!;
    expect(live.command).toBeUndefined();
    expect(live.detail?.endsWith("…")).toBe(true);

    const history = await master.history("codex-contract-1", 100);
    const merged = mergeSessionEvents(history, agent.events);
    const restored = merged.find((event) => event.id === "contract-terminal-1")!;
    expect(restored.command).toBe("bun test --cwd apps/server");
    expect(restored.detail).toBe(longDetail);
  });

  test("republishing an id revises the event instead of duplicating it", async () => {
    await publish("/agents/codex-contract-1/events", {
      kind: "tool",
      summary: "Edit",
      path: "/tmp/file.ts",
      id: "contract-edit-1",
    });
    await publish("/agents/codex-contract-1/events", {
      kind: "tool",
      summary: "Edit",
      path: "/tmp/file.ts",
      diff: "+added later",
      id: "contract-edit-1",
    });
    const history = await master.history("codex-contract-1", 100);
    const copies = history.filter((event) => event.id === "contract-edit-1");
    expect(copies).toHaveLength(1);
  });

  test("a prompt to a blocked session is refused with the bridge's sentence; force queues; approve passes", async () => {
    await heartbeat("codex-contract-blocked", {
      state: "waiting",
      capabilities: ["approve", "reject", "prompt"],
      pendingApproval: {
        id: "req-contract-1",
        tool: "Bash",
        detail: "rm -rf build",
        createdAt: at,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });

    const attempt = master.control("codex-contract-blocked", "prompt", "keep going");
    await expect(attempt).rejects.toBeInstanceOf(AgentBlockedError);
    await expect(master.control("codex-contract-blocked", "prompt", "keep going")).rejects.toThrow(
      "waiting for approval to run Bash",
    );

    const forced = await master.control("codex-contract-blocked", "prompt", "keep going", {
      force: true,
    });
    expect(forced.action).toBe("prompt");

    const approved = await master.control("codex-contract-blocked", "approve");
    expect(approved.action).toBe("approve");
    const receipt = await master.receipt(approved.id);
    expect(receipt.commandId).toBe(approved.id);
  });

  test("a stale state report is dropped by origin sequence", async () => {
    const report = (seq: number, state: string) =>
      publish("/agents/codex-contract-1/runtime-events", {
        id: `contract-state-${seq}`,
        agentId: "codex-contract-1",
        type: "session.state.changed",
        createdAt: at,
        origin: { source: "contract-suite", seq },
        payload: { state, task: "under test" },
      });

    const fresh = await report(2, "idle");
    expect(fresh.status).toBe(201);
    expect(fresh.body.accepted).not.toBe(false);

    const stale = await report(1, "running");
    expect(stale.status).toBe(201);
    expect(stale.body).toEqual({ accepted: false, reason: "stale" });
  });

  test("a state authority claim holds against another publisher, then releases", async () => {
    await heartbeat("codex-contract-lease", { runtimeProtocol: "canonical-v1" });
    const report = (seq: number, source: string, payload: WirePayload) =>
      publish("/agents/codex-contract-lease/runtime-events", {
        id: `contract-lease-${source}-${seq}`,
        agentId: "codex-contract-lease",
        type: "session.state.changed",
        createdAt: new Date().toISOString(),
        origin: { source, seq },
        payload,
      });

    await report(1, "herdr-suite", {
      state: "waiting",
      task: "Prompt on screen",
      claim: { ttlMs: 60_000 },
    });
    // A delayed report from the other publisher: logged, but it must not move
    // the session while the claim is live.
    await report(1, "hooks-suite", { state: "idle", task: "Ready" });
    const held = await master.agent("codex-contract-lease");
    expect(held?.state).toBe("waiting");
    expect(held?.task).toBe("Prompt on screen");
    expect(held?.stateAuthority?.source).toBe("herdr-suite");

    // The holder reporting without a claim is the release.
    await report(2, "herdr-suite", { state: "idle", task: "Ready for an instruction" });
    const released = await master.agent("codex-contract-lease");
    expect(released?.state).toBe("idle");
    expect(released?.stateAuthority).toBeUndefined();
  });

  test("a canonical session's projection is believed over its heartbeat", async () => {
    // ADR-0001's central claim, executed: for a runtime that declared
    // canonical-v1, state, task, and identity come from the folded event log,
    // and a later heartbeat repeating a stale view does not win them back.
    await heartbeat("codex-contract-proj", {
      runtimeProtocol: "canonical-v1",
      state: "running",
      task: "heartbeat says running",
    });
    await publish("/agents/codex-contract-proj/runtime-events", {
      id: "contract-proj-registered",
      agentId: "codex-contract-proj",
      type: "session.registered",
      createdAt: at,
      payload: { name: "Projected Name", project: "contract", model: "projected-model" },
    });
    await publish("/agents/codex-contract-proj/runtime-events", {
      id: "contract-proj-state",
      agentId: "codex-contract-proj",
      type: "session.state.changed",
      createdAt: new Date().toISOString(),
      origin: { source: "contract-suite-proj", seq: 1 },
      payload: { state: "waiting", task: "Projected waiting" },
    });
    await heartbeat("codex-contract-proj", {
      runtimeProtocol: "canonical-v1",
      state: "running",
      task: "heartbeat still says running",
    });
    const agent = await master.agent("codex-contract-proj");
    expect(agent?.state).toBe("waiting");
    expect(agent?.task).toBe("Projected waiting");
    expect(agent?.name).toBe("Projected Name");
  });

  test("a resolution fits its kind, and lands exactly once", async () => {
    await heartbeat("codex-contract-ledger", { runtimeProtocol: "canonical-v1" });
    await publish("/agents/codex-contract-ledger/runtime-events", {
      id: "contract-ledger-open",
      agentId: "codex-contract-ledger",
      type: "request.opened",
      createdAt: at,
      requestId: "contract-ledger-r1",
      payload: {
        kind: "approval",
        tool: "Bash",
        detail: "rm -rf build",
        createdAt: at,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    const resolve = (status: string) =>
      publish("/agents/codex-contract-ledger/requests/contract-ledger-r1/resolve", { status });

    // An answer settles a question, never an approval.
    expect((await resolve("answered")).status).toBe(404);
    expect((await resolve("approved")).status).toBe(200);
    // Settled means settled: a second decision has nothing left to resolve.
    expect((await resolve("rejected")).status).toBe(404);
    const standing = await fetch(
      `${base}/bridge/v1/agents/codex-contract-ledger/requests/contract-ledger-r1`,
      { headers: { Authorization: `Bearer ${MASTER}` } },
    );
    // SAFETY: the route answers the documented `{status}` shape; this test is
    // what holds it to that.
    expect(((await standing.json()) as { status?: string }).status).toBe("approved");
  });

  test("a wait parks on the bridge and wakes on the change that settles it", async () => {
    await heartbeat("codex-contract-wait", { runtimeProtocol: "canonical-v1" });
    await publish("/agents/codex-contract-wait/runtime-events", {
      id: "contract-wait-open",
      agentId: "codex-contract-wait",
      type: "user-input.requested",
      createdAt: new Date().toISOString(),
      requestId: "contract-wait-r1",
      payload: {
        kind: "user-input",
        question: "Which?",
        options: ["A", "B"],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });

    // The poller parks first; the answer lands a beat later.
    const startedAt = Date.now();
    const parked = fetch(
      `${base}/bridge/v1/agents/codex-contract-wait/requests/contract-wait-r1?wait=10`,
      { headers: { Authorization: `Bearer ${MASTER}` } },
    );
    await Bun.sleep(250);
    await publish("/agents/codex-contract-wait/requests/contract-wait-r1/resolve", {
      status: "answered",
      value: "A",
    });
    // SAFETY: the route answers the documented `{status, value}` shape.
    const standing = (await (await parked).json()) as { status?: string; value?: unknown };
    const elapsed = Date.now() - startedAt;
    expect(standing.status).toBe("answered");
    expect(standing.value).toBe("A");
    // Woken by the resolution, not the ten-second window running out.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(8_000);
  });

  test("a command wait wakes when the command queues", async () => {
    const startedAt = Date.now();
    const parked = fetch(`${base}/bridge/v1/agents/codex-contract-wait/commands?wait=10`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    await Bun.sleep(250);
    const queued = await master.control("codex-contract-wait", "prompt", "keep going");
    // SAFETY: the route answers the documented `{commands}` shape.
    const result = (await (await parked).json()) as { commands?: Array<{ id: string }> };
    const elapsed = Date.now() - startedAt;
    expect(result.commands?.some((command) => command.id === queued.id)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(8_000);
  });

  test("explain says whose word each fact is", async () => {
    // codex-contract-proj registered itself and holds a canonical projection;
    // codex-contract-1 only ever heartbeated its identity.
    const explain = async (id: string) =>
      // SAFETY: the route answers the documented explanation shape.
      (await (
        await fetch(`${base}/bridge/v1/agents/${id}/explain`, {
          headers: { Authorization: `Bearer ${MASTER}` },
        })
      ).json()) as {
        identity?: { source: string; confidence: string };
        state?: { source: string; confidence: string };
      };

    const registered = await explain("codex-contract-proj");
    expect(registered.identity).toEqual({ source: "session.registered", confidence: "registered" });
    expect(registered.state).toEqual({ source: "runtime-events", confidence: "projected" });

    const legacy = await explain("codex-contract-1");
    expect(legacy.identity).toEqual({ source: "heartbeat", confidence: "reported" });
    expect(legacy.state?.source).toBe("heartbeat");
  });

  test("a malformed runtime event is refused with its reason, not swallowed", async () => {
    const refused = await publish("/agents/codex-contract-1/runtime-events", {
      id: "contract-malformed-1",
      agentId: "codex-contract-1",
      type: "session.exploded",
      createdAt: at,
      payload: {},
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error ?? refused.body.reason ?? "")).toContain("event type");
  });

  test("a replayed event id collapses onto its first landing", async () => {
    const event = {
      id: "contract-replay-1",
      agentId: "codex-contract-1",
      type: "item.completed",
      createdAt: at,
      payload: { kind: "tool", summary: "Bash" },
    };
    const first = await publish("/agents/codex-contract-1/runtime-events", event);
    const again = await publish("/agents/codex-contract-1/runtime-events", event);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.sequence).toBe(first.body.sequence);
  });

  test("marking seen is shared state, and unknown sessions are 404", async () => {
    const viewedAt = await master.markSeen("codex-contract-1");
    const agent = await master.agent("codex-contract-1");
    expect(agent?.viewedAt).toBe(viewedAt);

    await expect(master.markSeen("codex-contract-ghost")).rejects.toBeInstanceOf(BridgeError);
  });

  test("the slash catalog round-trips", async () => {
    await publish("/agents/codex-contract-1/slash-commands", {
      commands: [{ name: "deploy", description: "Ship it", source: "user" }],
    });
    const commands = await master.slashCommands("codex-contract-1");
    expect(commands).toEqual([{ name: "deploy", description: "Ship it", source: "user" }]);
  });

  test("the wire says where a session works, and a later beat cannot unsay it", async () => {
    await heartbeat("codex-contract-cwd", { cwd: "/repos/deck" });
    expect((await master.agent("codex-contract-cwd"))?.cwd).toBe("/repos/deck");
    // A beat that omits the field must not erase the fact.
    await heartbeat("codex-contract-cwd", { task: "still going" });
    expect((await master.agent("codex-contract-cwd"))?.cwd).toBe("/repos/deck");
  });

  test("events carry the turn they belong to", async () => {
    await publish("/agents/codex-contract-1/events", {
      kind: "output",
      summary: "Response",
      detail: "threaded",
      id: "contract-turn-1",
      turnId: "turn-abc",
    });
    const history = await master.history("codex-contract-1", 100);
    expect(history.find((event) => event.id === "contract-turn-1")?.turnId).toBe("turn-abc");
  });

  test("history pages backwards with `before`", async () => {
    const whole = await master.history("codex-contract-1", 100);
    const pivot = whole[Math.floor(whole.length / 2)]!;
    const page = await master.history("codex-contract-1", 100, pivot.createdAt);
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((event) => event.createdAt < pivot.createdAt)).toBe(true);
  });

  test("dismissing a session clears the deck but keeps its history", async () => {
    await heartbeat("codex-contract-dismissed", {});
    await publish("/agents/codex-contract-dismissed/events", {
      kind: "output",
      summary: "Response",
      detail: "remembered",
      id: "contract-dismiss-1",
    });
    await master.dismiss("codex-contract-dismissed");
    expect(await master.agent("codex-contract-dismissed")).toBeUndefined();
    const history = await master.history("codex-contract-dismissed", 10);
    expect(history.some((event) => event.id === "contract-dismiss-1")).toBe(true);
    await expect(master.dismiss("codex-contract-dismissed")).rejects.toBeInstanceOf(BridgeError);
  });

  test("the stream opens with a snapshot and every change lands as a patch", async () => {
    const decks: BridgeSnapshot[] = [];
    const subscription = subscribeDeck(base, MASTER, {
      onSnapshot: (snapshot) => decks.push(snapshot),
      reconnectDelayMs: 60_000,
    });
    const settled = Date.now() + 5_000;
    while (decks.length < 1 && Date.now() < settled) await Bun.sleep(20);
    expect(decks.length).toBeGreaterThanOrEqual(1);

    await publish("/agents/codex-contract-1/events", {
      kind: "output",
      summary: "Response",
      detail: "patch me through",
      id: "contract-stream-1",
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const latest = decks[decks.length - 1]!;
      const arrived = latest.agents
        .find((agent) => agent.id === "codex-contract-1")
        ?.events.some((event) => event.id === "contract-stream-1");
      if (arrived) break;
      await Bun.sleep(20);
    }
    subscription.close();

    const final = decks[decks.length - 1]!;
    expect(
      final.agents
        .find((agent) => agent.id === "codex-contract-1")
        ?.events.some((event) => event.id === "contract-stream-1"),
    ).toBe(true);
  });

  test("a restarted bridge keeps its deck, its sequence, and its credentials", async () => {
    // The failure every durable claim exists for: kill the process outright
    // and bring a fresh one up on the same database.
    const before = await master.snapshot();
    bridge.kill();
    await bridge.exited;
    bridge = spawnBridge();
    await waitAlive();

    const after = await master.snapshot();
    // The Snapshot Sequence is durable: a client holding `before` never sees
    // a lower number, so nothing it applied rolls back.
    expect(after.sequence).toBeGreaterThanOrEqual(before.sequence);
    expect(after.agents.some((agent) => agent.id === "codex-contract-1")).toBe(true);
    // A settled request stays settled across the restart.
    const standing = await fetch(
      `${base}/bridge/v1/agents/codex-contract-ledger/requests/contract-ledger-r1`,
      { headers: { Authorization: `Bearer ${MASTER}` } },
    );
    // SAFETY: the route answers the documented `{status}` shape.
    expect(((await standing.json()) as { status?: string }).status).toBe("approved");
  });
});
