import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import agentDeckExtension from "./index";

/** The slice of a Pi event these tests ever fire; reload cases carry nothing. */
type FiredEvent = {
  toolName?: string;
  isError?: boolean;
};

type FakeContext = ReturnType<typeof fakeContext>;
type Handler = (event: FiredEvent, ctx: FakeContext) => Promise<void> | void;

/** Captures the handlers an extension instance registers, standing in for the Pi runtime. */
function fakePi() {
  const handlers = new Map<string, Handler>();
  return {
    api: {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: () => {},
      getSessionName: () => "Pi · test",
    },
    fire: (name: string, event: FiredEvent, ctx: FakeContext) => handlers.get(name)?.(event, ctx),
  };
}

/** Registers the extension against a fake runtime. */
function install(pi: ReturnType<typeof fakePi>) {
  // SAFETY: the fake carries the three ExtensionAPI members the extension
  // touches; `never` satisfies the imported parameter type without pulling the
  // real runtime into the test.
  agentDeckExtension(pi.api as never);
}

function fakeContext(sessionId: string) {
  return {
    cwd: "/tmp/project",
    model: { provider: "anthropic", id: "opus" },
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text } },
  };
}

const RELOAD_HANDOFF = Symbol.for("agent-deck.pi.reload-handoff");

/** The slice of each posted body these tests read back. */
type PostedBody = {
  id?: string;
  state?: string;
};

let posts: Array<{ path: string; body: PostedBody }>;
let originalFetch: typeof fetch;

beforeEach(() => {
  posts = [];
  originalFetch = globalThis.fetch;
  // SAFETY: the extension only ever calls the mock as a plain request function;
  // the statics Bun hangs off `fetch` (preconnect) go unused here.
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
  // SAFETY: clears the reload-handoff slot the extension declares on
  // globalThis; the test only ever writes undefined, so undefined is the whole
  // value contract it needs.
  (globalThis as Record<symbol, undefined>)[RELOAD_HANDOFF] = undefined;
});

const heartbeats = () => posts.filter((post) => post.path.endsWith("/agents/heartbeat"));

describe("/reload handoff", () => {
  test("a reloaded instance keeps heartbeating without waiting for session_start", async () => {
    const first = fakePi();
    install(first);
    await first.fire("session_start", {}, fakeContext("session-1"));
    expect(heartbeats().length).toBeGreaterThan(0);

    // `/reload` builds a new instance; session_start does not fire again for it.
    posts = [];
    const second = fakePi();
    install(second);
    await Bun.sleep(10);

    expect(heartbeats().length).toBeGreaterThan(0);
    expect(heartbeats()[0]!.body.id).toBe("session-1");
    expect(heartbeats()[0]!.body.state).not.toBe("offline");
  });

  test("the outgoing instance does not mark the session offline after being replaced", async () => {
    const first = fakePi();
    install(first);
    await first.fire("session_start", {}, fakeContext("session-1"));

    const second = fakePi();
    install(second);

    posts = [];
    await first.fire("session_shutdown", {}, fakeContext("session-1"));

    expect(heartbeats().filter((post) => post.body.state === "offline")).toEqual([]);
  });

  test("a genuine shutdown still reports the session offline", async () => {
    const only = fakePi();
    install(only);
    await only.fire("session_start", {}, fakeContext("session-1"));

    posts = [];
    await only.fire("session_shutdown", {}, fakeContext("session-1"));

    expect(heartbeats().some((post) => post.body.state === "offline")).toBe(true);
  });

  test("an event on a reloaded instance revives the loops even with nothing inherited", async () => {
    const reloaded = fakePi();
    install(reloaded);

    posts = [];
    await reloaded.fire("agent_start", {}, fakeContext("session-2"));
    await Bun.sleep(10);

    expect(heartbeats().some((post) => post.body.id === "session-2")).toBe(true);
  });
});
