import { describe, expect, test } from "bun:test";
import {
  acceptsPrompt,
  correctionFor,
  deckAgentId,
  isDeckRuntime,
  TERMINAL_PROMPT_TASK,
  type StoredSession,
} from "./reconcile";

describe("deckAgentId", () => {
  test("derives the id the hooks derive", () => {
    // Taken from a live pairing: this Herdr session id is the one the deck is
    // holding under this agent id, verified against the bridge's own store.
    expect(deckAgentId("claude", "ba940710-4089-4c6f-a44e-8b716f49095f")).toBe(
      "claude-fb319498039a87a4232f2512",
    );
  });

  test("a different session is a different agent", () => {
    expect(deckAgentId("claude", "a")).not.toBe(deckAgentId("claude", "b"));
  });
});

describe("isDeckRuntime", () => {
  test("claims the runtimes the deck installs hooks into", () => {
    expect(isDeckRuntime("claude")).toBe(true);
    expect(isDeckRuntime("codex")).toBe(true);
  });

  test("leaves other agents Herdr manages alone", () => {
    expect(isDeckRuntime("opencode")).toBe(false);
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
  const stored = (over: Partial<StoredSession> = {}): StoredSession => ({
    state: "idle",
    task: "Ready for an instruction",
    holdingApproval: false,
    ...over,
  });

  test("claims a session Herdr sees stopped at a prompt", () => {
    expect(correctionFor("blocked", stored())).toBe("block");
  });

  test("says it once and then stays quiet", () => {
    const claimed = stored({ state: "waiting", task: TERMINAL_PROMPT_TASK });
    expect(correctionFor("blocked", claimed)).toBeUndefined();
  });

  test("withdraws the claim once the prompt clears", () => {
    const claimed = stored({ state: "waiting", task: TERMINAL_PROMPT_TASK });
    expect(correctionFor("idle", claimed)).toBe("clear");
    expect(correctionFor("working", claimed)).toBe("clear");
  });

  test("never touches a session it did not claim", () => {
    // The hooks are describing a real approval; this is not ours to withdraw.
    expect(
      correctionFor("idle", stored({ state: "waiting", task: "Approval: Bash" })),
    ).toBeUndefined();
    expect(correctionFor("working", stored({ task: "Using Bash" }))).toBeUndefined();
  });

  test("leaves a live approval to the hooks, which know what is asking", () => {
    const approving = stored({ state: "waiting", task: "Approval: Bash", holdingApproval: true });
    expect(correctionFor("blocked", approving)).toBeUndefined();
    expect(correctionFor("idle", approving)).toBeUndefined();
  });

  test("re-claims a session a hook has since described differently", () => {
    // Idempotence is the point: the claim is restated from current facts rather
    // than remembered, so a hook's write does not silently end it.
    expect(correctionFor("blocked", stored({ state: "running", task: "Using Bash" }))).toBe(
      "block",
    );
  });
});
