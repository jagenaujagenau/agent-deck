import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHookEvent } from "./hook-handler";

/**
 * The trunk, exercised through its own seam.
 *
 * Eleven leaf modules around this handler carry their own tests; this drives
 * the lifecycle switch itself — request in, published facts out — against a
 * fake bridge, the way the daemon's socket server and a fallback hook process
 * actually call it. What lands on the wire is the contract the phone lives
 * on, so that is what the assertions read.
 */

const SESSION_ID = "trunk-session-1";
const AGENT_ID = `claude-${createHash("sha256").update(SESSION_ID).digest("hex").slice(0, 24)}`;

/** A canonical runtime event as this suite's own handler posts it. */
type PublishedEvent = {
  type: string;
  turnId?: string;
  origin?: { source: string; seq: number };
  payload: {
    state?: string;
    task?: string;
    kind?: string;
    tool?: string;
    status?: string;
    objective?: string;
    claim?: { ttlMs: number };
  };
};

type PostedCardEvent = { kind?: string; detail?: string };
type PostedHeartbeat = { id?: string; runtimeProtocol?: string };

type Recorded = { method: string; path: string; body?: unknown };

/** The stdin payload a Claude Code hook writes, as far as this suite speaks it. */
type HookStdin = {
  prompt?: string;
  message?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: { command?: string };
};

const requests: Recorded[] = [];
let commands: Array<{ id: string; action: string }> = [];
let bridge: ReturnType<typeof Bun.serve>;
let stateDir = "";
let workDir = "";
const savedEnv: Record<string, string | undefined> = {};

/** Every canonical runtime event published so far, in arrival order. */
function published(): PublishedEvent[] {
  const bodies = requests
    .filter((r) => r.method === "POST" && r.path.endsWith("/runtime-events"))
    .map((r) => r.body);
  // SAFETY: the fake bridge recorded exactly what this suite's own handler
  // posted, and the handler only posts canonical runtime events.
  return bodies as PublishedEvent[];
}

/** The card events this suite's handler posted for the session. */
function postedCardEvents(): PostedCardEvent[] {
  const bodies = requests
    .filter((r) => r.method === "POST" && r.path.endsWith(`/agents/${AGENT_ID}/events`))
    .map((r) => r.body);
  // SAFETY: recorded from this suite's own handler, which posts AgentEvent inputs there.
  return bodies as PostedCardEvent[];
}

/** The last heartbeat this suite's handler posted. */
function lastHeartbeat(): PostedHeartbeat | undefined {
  const body = requests.findLast((r) => r.path.endsWith("/agents/heartbeat"))?.body;
  // SAFETY: recorded from this suite's own handler, which posts heartbeats there.
  return body as PostedHeartbeat | undefined;
}

const hook = (event: string, payload: HookStdin) =>
  handleHookEvent({
    runtime: "claude",
    expectedEvent: event,
    payloadText: JSON.stringify({
      session_id: SESSION_ID,
      hook_event_name: event,
      cwd: workDir,
      ...payload,
    }),
    hookCwd: workDir,
    hookPpid: process.pid,
  });

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hook-trunk-state-"));
  workDir = mkdtempSync(join(tmpdir(), "hook-trunk-work-"));
  const keys = [
    "AGENT_DECK_STATE_DIR",
    "AGENT_DECK_URL",
    "AGENT_DECK_TOKEN",
    "AGENT_DECK_APPROVAL_MODE",
  ];
  for (const key of keys) {
    savedEnv[key] = process.env[key];
  }
  bridge = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const record: Recorded = { method: request.method, path };
      const respond = (body: Record<string, boolean | Array<{ id: string; action: string }>>) =>
        new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (request.method === "GET") {
        requests.push(record);
        if (path.endsWith("/commands")) return respond({ commands });
        return respond({});
      }
      // An acknowledgement posts no body at all; a parser that assumes one
      // turns that into a 500 and strands the flow that sent it.
      return request.text().then((text) => {
        if (text) record.body = JSON.parse(text);
        requests.push(record);
        return respond({ accepted: true });
      });
    },
  });
  process.env.AGENT_DECK_STATE_DIR = stateDir;
  process.env.AGENT_DECK_URL = `http://127.0.0.1:${bridge.port}`;
  process.env.AGENT_DECK_TOKEN = "trunk-test-token";
  process.env.AGENT_DECK_APPROVAL_MODE = "all";
  // A pid file naming a live process is what keeps the handler from spawning
  // a real daemon at the test runner.
  writeFileSync(join(stateDir, `${AGENT_ID}.json.pid`), String(process.pid));
});

afterAll(() => {
  bridge?.stop(true);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the hook lifecycle trunk", () => {
  test("a session start registers the session and reports it idle", async () => {
    await hook("SessionStart", {});
    // The state file landed in the scratch directory — everything below
    // depends on that redirection actually holding.
    expect(existsSync(join(stateDir, `${AGENT_ID}.json`))).toBe(true);
    const events = published();
    const registered = events.find((event) => event.type === "session.registered");
    expect(registered?.origin?.source).toBe("claude-hooks");
    expect(
      events.some(
        (event) => event.type === "session.state.changed" && event.payload.state === "idle",
      ),
    ).toBe(true);
    expect(lastHeartbeat()?.id).toBe(AGENT_ID);
    expect(lastHeartbeat()?.runtimeProtocol).toBe("canonical-v1");
  });

  test("a prompt starts a turn and publishes the person's words as theirs", async () => {
    await hook("UserPromptSubmit", { prompt: "Fix the flaky test" });
    const turn = published().find((event) => event.type === "turn.started");
    expect(turn?.payload.objective).toBe("Fix the flaky test");
    expect(turn?.turnId).toBeTruthy();
    const message = postedCardEvents().find((event) => event.kind === "user");
    expect(message?.detail).toBe("Fix the flaky test");
  });

  test("an approval opens a request, claims the waiting report, and resolves on the remote decision", async () => {
    commands = [{ id: "c1", action: "approve" }];
    const result = await hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    commands = [];
    const events = published();
    const opened = events.find((event) => event.type === "request.opened");
    expect(opened?.payload.kind).toBe("approval");
    expect(opened?.payload.tool).toBe("Bash");
    const claimed = events.find(
      (event) => event.type === "session.state.changed" && event.payload.state === "waiting",
    );
    expect(claimed?.payload.claim?.ttlMs).toBeGreaterThan(0);
    const resolved = events.find((event) => event.type === "request.resolved");
    expect(resolved?.payload.status).toBe("approved");
    expect(result.stdout).toContain('"permissionDecision":"allow"');
  });

  test("a notification about the terminal reports waiting without a claim", async () => {
    await hook("Notification", { message: "Claude needs your permission to use Bash" });
    const waiting = published()
      .filter(
        (event) => event.type === "session.state.changed" && event.payload.state === "waiting",
      )
      .at(-1);
    // No deck-answerable request is open, so the observer reading the screen
    // keeps the right to describe it — the report must not claim.
    expect(waiting?.payload.claim).toBeUndefined();
    expect(waiting?.payload.task).toBe("Claude needs your permission to use Bash");
  });

  test("a stop completes the turn and reports usage", async () => {
    await hook("Stop", { last_assistant_message: "Done: test fixed" });
    const events = published();
    const completed = events.filter((event) => event.type === "turn.completed").at(-1);
    expect(completed?.payload.status).toBe("completed");
    expect(events.some((event) => event.type === "token-usage.updated")).toBe(true);
  });

  test("every report rode one shared, strictly ascending order", () => {
    const events = published();
    expect(events.every((event) => event.origin?.source === "claude-hooks")).toBe(true);
    const sequences = events.map((event) => event.origin?.seq ?? Number.NaN);
    expect(sequences.every(Number.isFinite)).toBe(true);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
  });
});
