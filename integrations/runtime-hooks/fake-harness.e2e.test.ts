import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fake harness walking the whole lifecycle through the real pipe.
 *
 * hook-handler.test.ts proves what the trunk posts; contract.test.ts proves
 * what the bridge answers. Neither proves the two speak the same dialect:
 * an adapter field the bridge quietly drops passes both suites and fails
 * only on a phone. So this drives the real handler at a real bridge
 * subprocess — spawn, instruct, work, block on an approval, answer it from
 * the device side, finish — and reads the deck's own snapshot after every
 * beat, because the snapshot is what every surface actually renders. No
 * tokens are spent: the "agent" is this file.
 */

const SESSION_ID = "fake-harness-session";
const AGENT_ID = `claude-${createHash("sha256").update(SESSION_ID).digest("hex").slice(0, 24)}`;
const MASTER = "fake-harness-master-token";

let bridge: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let stateDir = "";
let workDir = "";

type SnapshotAgent = {
  id: string;
  state: string;
  objective?: string;
  pendingApproval?: { id: string; tool: string };
  events: Array<{ kind: string; summary: string; detail?: string; tool?: string }>;
};

const snapshotAgent = async (): Promise<SnapshotAgent | undefined> => {
  const response = await fetch(`${base}/bridge/v1/snapshot`, {
    headers: { Authorization: `Bearer ${MASTER}`, Connection: "close" },
  });
  const body = (await response.json()) as { agents: SnapshotAgent[] };
  return body.agents.find((agent) => agent.id === AGENT_ID);
};

/** Poll the snapshot until it says what the beat should have made true. */
const until = async (test: (agent: SnapshotAgent | undefined) => boolean) => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const agent = await snapshotAgent();
    if (test(agent)) return agent;
    if (Date.now() > deadline) return agent;
    await Bun.sleep(100);
  }
};

/**
 * One hook delivery, as production makes it: the real shim, spawned as its
 * own process with the payload on stdin, pointed at the real bridge.
 */
const hook = async (event: string, payload: Record<string, unknown>) => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "index.ts"), "claude", event], {
    cwd: workDir,
    env: {
      ...process.env,
      AGENT_DECK_STATE_DIR: stateDir,
      AGENT_DECK_URL: base,
      AGENT_DECK_TOKEN: MASTER,
      AGENT_DECK_APPROVAL_MODE: "all",
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: SESSION_ID, hook_event_name: event, cwd: workDir, ...payload }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  return { stdout };
};

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "fake-harness-state-"));
  workDir = mkdtempSync(join(tmpdir(), "fake-harness-work-"));
  const databaseUrl = `file:${join(stateDir, "bridge.db")}`;
  // Probe for a free port the way contract.test.ts does.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  bridge = Bun.spawn(["bun", "src/effect/main.ts"], {
    cwd: join(import.meta.dir, "..", "..", "apps", "server"),
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
  // Prove liveness before the first hook fires.
  const alive = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > alive) throw new Error("bridge did not come up");
    await Bun.sleep(100);
  }
  // A pid file naming a live process keeps the handler from spawning a
  // real daemon at the test runner.
  writeFileSync(join(stateDir, `${AGENT_ID}.json.pid`), String(process.pid));
});

afterAll(() => {
  bridge?.kill();
});

describe("the fake harness, end to end", () => {
  test("the whole lifecycle, one beat at a time", async () => {
    // Spawn: the deck learns the session exists and shows it idle.
    await hook("SessionStart", {});
    let agent = await until((a) => a?.state === "idle");
    expect(agent?.id).toBe(AGENT_ID);

    // Instruct: running, with the person's words as the objective.
    await hook("UserPromptSubmit", { prompt: "Fix the flaky socket test" });
    agent = await until((a) => a?.state === "running");
    expect(agent?.objective).toBe("Fix the flaky socket test");
    expect(
      agent?.events.some((e) => e.kind === "user" && e.detail === "Fix the flaky socket test"),
    ).toBe(true);

    // Work: tool events stream in, foldable by the conversation.
    await hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "src/socket.ts" } });
    agent = await until((a) => a?.events.some((e) => e.tool === "Read") ?? false);
    expect(agent?.events.some((e) => e.tool === "Read")).toBe(true);

    // Block: the handler parks inside PreToolUse until the decision arrives,
    // so the device answers concurrently, the way a phone would.
    const parked = hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    const waiting = await until((a) => a?.pendingApproval !== undefined && a.state === "waiting");
    expect(waiting?.state).toBe("waiting");
    expect(waiting?.pendingApproval?.tool).toBe("Bash");

    // Decide, from the device side — the phone's own route: a control
    // command the parked handler polls up and acknowledges.
    const resolve = Bun.spawn(
      [
        "curl",
        "-s",
        "-m",
        "5",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        "-H",
        `Authorization: Bearer ${MASTER}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ action: "approve" }),
        `${base}/bridge/v1/agents/${AGENT_ID}/control`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    expect(await new Response(resolve.stdout).text()).toBe("202");
    await resolve.exited;
    const decision = await parked;
    expect(decision.stdout ?? "").toContain('"permissionDecision":"allow"');
    await until((a) => a?.pendingApproval === undefined);

    // Finish: the deck reads idle again with the conversation intact. The
    // reply text itself is the daemon's to publish (it tails the transcript),
    // and the fake harness runs no daemon — so idle-with-history is the
    // honest promise this path makes.
    await hook("Stop", { last_assistant_message: "The socket test holds across twenty runs." });
    agent = await until((a) => a?.state === "idle");
    expect(agent?.state).toBe("idle");
    expect(agent?.events.some((e) => e.kind === "user")).toBe(true);
    expect(agent?.events.some((e) => e.tool === "Read")).toBe(true);
  }, 60_000);
});
