import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import agentDeckExtension from "./index";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  return {
    api: {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: () => {},
      getSessionName: () => "Pi · test",
    },
    fire: (name: string, event: unknown, ctx: unknown) => handlers.get(name)?.(event, ctx),
  };
}

const fakeContext = (sessionId: string) => ({
  cwd: "/tmp/project",
  model: { provider: "anthropic", id: "opus" },
  isIdle: () => false,
  sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  ui: { setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text } },
});

const RELOAD_HANDOFF = Symbol.for("agent-deck.pi.reload-handoff");
let posts: Array<{ path: string; body: Record<string, unknown> }>;
let originalFetch: typeof fetch;

beforeEach(() => {
  posts = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ commands: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as Record<symbol, unknown>)[RELOAD_HANDOFF] = undefined;
});

/** Handlers publish without awaiting, so let the chained posts land. */
const settle = () => Bun.sleep(30);

/**
 * The deck derives this runtime's state from its event stream, not its
 * heartbeat, so the events are what these assert on.
 */
const runtimeEvents = () =>
  posts
    .filter((post) => post.path.endsWith("/runtime-events"))
    .map((post) => post.body as { type: string; payload: Record<string, unknown> });

const projectedState = () => {
  const carrying = runtimeEvents().filter(
    (event) => event.type === "item.started" || event.type === "session.state.changed",
  );
  const last = carrying.at(-1);
  return last?.type === "item.started" ? "running" : last?.payload.state;
};

describe("a question the deck could not take", () => {
  test("blocks the session rather than reporting it as running", async () => {
    const pi = fakePi();
    agentDeckExtension(pi.api as never);
    await pi.fire("session_start", {}, fakeContext("session-q1"));
    await pi.fire("agent_start", {}, fakeContext("session-q1"));

    // An open question carries no options, so tool_call hands it to the terminal
    // and the tool goes on to execute. That execution is the session blocking.
    posts = [];
    await pi.fire(
      "tool_execution_start",
      { toolName: "AskUserQuestion", args: { questions: [{ question: "Which branch?" }] } },
      fakeContext("session-q1"),
    );
    await settle();

    expect(projectedState()).toBe("waiting");
  });

  test("says waiting after item.started, not before it", async () => {
    const pi = fakePi();
    agentDeckExtension(pi.api as never);
    await pi.fire("session_start", {}, fakeContext("session-q2"));
    await pi.fire("agent_start", {}, fakeContext("session-q2"));

    posts = [];
    await pi.fire(
      "tool_execution_start",
      { toolName: "AskUserQuestion", args: { questions: [{ question: "Which branch?" }] } },
      fakeContext("session-q2"),
    );
    await settle();

    const order = runtimeEvents()
      .map((event) => event.type)
      .filter((type) => type === "item.started" || type === "session.state.changed");
    expect(order).toEqual(["item.started", "session.state.changed"]);
  });

  test("names the question, so the deck says what is being asked", async () => {
    const pi = fakePi();
    agentDeckExtension(pi.api as never);
    await pi.fire("session_start", {}, fakeContext("session-q3"));
    await pi.fire("agent_start", {}, fakeContext("session-q3"));

    posts = [];
    await pi.fire(
      "tool_execution_start",
      { toolName: "AskUserQuestion", args: { questions: [{ question: "Which branch?" }] } },
      fakeContext("session-q3"),
    );
    await settle();

    const changed = runtimeEvents().find((event) => event.type === "session.state.changed");
    expect(changed?.payload.task).toBe("Which branch?");
  });

  test("answering it lets the session read as running again", async () => {
    const pi = fakePi();
    agentDeckExtension(pi.api as never);
    await pi.fire("session_start", {}, fakeContext("session-q4"));
    await pi.fire("agent_start", {}, fakeContext("session-q4"));
    await pi.fire(
      "tool_execution_start",
      { toolName: "AskUserQuestion", args: { questions: [{ question: "Which branch?" }] } },
      fakeContext("session-q4"),
    );
    await settle();

    posts = [];
    await pi.fire(
      "tool_execution_end",
      { toolName: "AskUserQuestion", isError: false, args: {} },
      fakeContext("session-q4"),
    );
    await settle();

    // item.completed is what returns the projection to running.
    expect(runtimeEvents().some((event) => event.type === "item.completed")).toBe(true);
    expect(runtimeEvents().some((event) => event.type === "session.state.changed")).toBe(false);
  });

  test("an ordinary tool never claims the session is blocked", async () => {
    const pi = fakePi();
    agentDeckExtension(pi.api as never);
    await pi.fire("session_start", {}, fakeContext("session-q5"));
    await pi.fire("agent_start", {}, fakeContext("session-q5"));

    posts = [];
    await pi.fire(
      "tool_execution_start",
      { toolName: "Bash", args: { command: "ls" } },
      fakeContext("session-q5"),
    );
    await settle();

    expect(projectedState()).toBe("running");
  });
});
