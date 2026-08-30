import { agentIdFor } from "../../packages/agent-adapter/src/agent-identity";
import { describe, expect, test } from "bun:test";
import { acceptsPrompt, correctionFor, isDeckRuntime, type StoredSession } from "./reconcile";

describe("agentIdFor", () => {
  test("derives the id the hooks derive", () => {
    // Taken from a live pairing: this Herdr session id is the one the deck is
    // holding under this agent id, verified against the bridge's own store.
    expect(agentIdFor("claude", "ba940710-4089-4c6f-a44e-8b716f49095f")).toBe(
      "claude-fb319498039a87a4232f2512",
    );
  });

  test("a different session is a different agent", () => {
    expect(agentIdFor("claude", "a")).not.toBe(agentIdFor("claude", "b"));
  });
});

describe("isDeckRuntime", () => {
  test("claims the runtimes the deck installs hooks into", () => {
    expect(isDeckRuntime("claude")).toBe(true);
    expect(isDeckRuntime("codex")).toBe(true);
  });

  test("claims OpenCode, which now has a plugin", () => {
    expect(isDeckRuntime("opencode")).toBe(true);
  });

  test("leaves other agents Herdr manages alone", () => {
    expect(isDeckRuntime("cursor")).toBe(false);
    expect(isDeckRuntime("droid")).toBe(false);
  });
});

describe("acceptsPrompt", () => {
  test("idle and done can take words", () => {
    expect(acceptsPrompt("idle")).toBe(true);
    expect(acceptsPrompt("done")).toBe(true);
  });

  test("nothing else does", () => {
    expect(acceptsPrompt("working")).toBe(false);
    expect(acceptsPrompt("blocked")).toBe(false);
    // "unknown" means an agent is present, not that it is ready.
    expect(acceptsPrompt("unknown")).toBe(false);
  });
});

describe("correctionFor", () => {
  const at = (over: Partial<StoredSession> = {}): StoredSession => ({
    state: "idle",
    holdingApproval: false,
    claimedByUs: false,
    ...over,
  });

  test("claims a session Herdr sees stopped at a prompt", () => {
    expect(correctionFor("blocked", at())).toBe("block");
  });

  test("says it once and then stays quiet", () => {
    expect(correctionFor("blocked", at({ state: "waiting", claimedByUs: true }))).toBeUndefined();
  });

  test("re-claims if something else moved the session out of waiting", () => {
    // A hook writing its own state does not mean the terminal stopped asking.
    expect(correctionFor("blocked", at({ state: "running", claimedByUs: true }))).toBe("block");
  });

  test("withdraws the claim once the prompt clears", () => {
    expect(correctionFor("idle", at({ state: "waiting", claimedByUs: true }))).toBe("clear");
    expect(correctionFor("working", at({ state: "waiting", claimedByUs: true }))).toBe("clear");
  });

  test("never withdraws a claim it did not make", () => {
    // The task now carries the question read off the screen, which looks no
    // different from something a hook wrote. Only our own claim is ours to end.
    expect(correctionFor("idle", at({ state: "waiting" }))).toBeUndefined();
    expect(correctionFor("working", at({ state: "running" }))).toBeUndefined();
  });

  test("leaves a live approval to the hooks, which know what is asking", () => {
    const approving = at({ state: "waiting", holdingApproval: true, claimedByUs: true });
    expect(correctionFor("blocked", approving)).toBeUndefined();
    expect(correctionFor("idle", approving)).toBeUndefined();
  });
});
