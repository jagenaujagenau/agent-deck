import { describe, expect, test } from "bun:test";
import { emptyRuntimeProjection, projectRuntimeEvent } from "./runtime-projector";
import type { CanonicalRuntimeEvent } from "./runtime-events";

const event = (
  type: CanonicalRuntimeEvent["type"],
  overrides: Partial<CanonicalRuntimeEvent> = {},
): CanonicalRuntimeEvent => ({
  id: crypto.randomUUID(),
  agentId: "agent-1",
  type,
  createdAt: "2026-08-24T00:00:00.000Z",
  payload: {},
  ...overrides,
});

describe("projectRuntimeEvent", () => {
  test("derives request attention only from an open request", () => {
    const opened = projectRuntimeEvent(
      emptyRuntimeProjection("agent-1"),
      event("request.opened", { requestId: "r1", payload: { tool: "Bash" } }),
      1,
    );
    expect(opened.state).toBe("waiting");
    expect(opened.pendingRequest?.id).toBe("r1");
    const resolved = projectRuntimeEvent(
      opened,
      event("request.resolved", { requestId: "r1", payload: { status: "approved" } }),
      2,
    );
    expect(resolved.pendingRequest).toBeUndefined();
    expect(resolved.state).toBe("running");
  });

  test("rejects delayed events by sequence", () => {
    const running = projectRuntimeEvent(
      emptyRuntimeProjection("agent-1"),
      event("turn.started"),
      4,
    );
    expect(
      projectRuntimeEvent(
        running,
        event("session.state.changed", { payload: { state: "idle" } }),
        3,
      ),
    ).toBe(running);
  });

  test("a runtime that reports paused stays paused", () => {
    // Pi reports paused; downgrading it to idle made the deck offer a resume
    // on a session it claimed was doing nothing.
    const paused = projectRuntimeEvent(
      emptyRuntimeProjection("agent-1"),
      event("session.state.changed", { payload: { state: "paused", task: "Paused" } }),
      1,
    );
    expect(paused.state).toBe("paused");
    expect(paused.task).toBe("Paused");
  });

  test("separates context pressure from monotonic processed usage", () => {
    const first = projectRuntimeEvent(
      emptyRuntimeProjection("agent-1"),
      event("token-usage.updated", { payload: { contextTokens: 10, processedTokens: 100 } }),
      1,
    );
    const reset = projectRuntimeEvent(
      first,
      event("token-usage.updated", { payload: { contextTokens: 4, processedTokens: 90 } }),
      2,
    );
    expect(reset.contextTokens).toBe(4);
    expect(reset.processedTokens).toBe(100);
  });
});

describe("session.registered", () => {
  const at = (
    type: CanonicalRuntimeEvent["type"],
    payload: CanonicalRuntimeEvent["payload"],
    seq: number,
  ): CanonicalRuntimeEvent => ({
    id: `e${seq}`,
    agentId: "a",
    type,
    createdAt: new Date(seq * 1000).toISOString(),
    payload,
  });

  const fold = (events: ReadonlyArray<CanonicalRuntimeEvent>) =>
    events.reduce(
      (projection, entry, index) => projectRuntimeEvent(projection, entry, index + 1),
      emptyRuntimeProjection("a"),
    );

  test("carries the identity the heartbeat used to be needed for", () => {
    const projection = fold([
      at(
        "session.registered",
        {
          name: "Claude · fx · 27d9",
          project: "fx",
          model: "Claude Code",
          runtime: "claude",
          capabilities: ["approve", "reject"],
        },
        1,
      ),
    ]);
    expect(projection.identity?.name).toBe("Claude · fx · 27d9");
    expect(projection.identity?.project).toBe("fx");
    expect(projection.identity?.capabilities).toEqual(["approve", "reject"]);
  });

  test("re-registering does not send a working session back to idle", () => {
    // A reconnect republishes identity. Treating that as a state change would
    // report every reconnecting session as freshly idle.
    const projection = fold([
      at("session.registered", { name: "n", project: "p", model: "m" }, 1),
      at("turn.started", { objective: "Doing the thing" }, 2),
      at("session.registered", { name: "n", project: "p", model: "m" }, 3),
    ]);
    expect(projection.state).toBe("running");
    expect(projection.task).toBe("Doing the thing");
  });

  test("a later registration updates the name without losing the rest", () => {
    const projection = fold([
      at("session.registered", { name: "old", project: "p", model: "m" }, 1),
      at("token-usage.updated", { contextTokens: 500, processedTokens: 900 }, 2),
      at("session.registered", { name: "new", project: "p", model: "m" }, 3),
    ]);
    expect(projection.identity?.name).toBe("new");
    expect(projection.contextTokens).toBe(500);
    expect(projection.usageKnown).toBe(true);
  });

  test("a session that never registers simply has no identity", () => {
    // Every runtime that has not been migrated yet, which is the state the
    // heartbeat still covers for.
    const projection = fold([at("session.state.changed", { state: "idle", task: "Ready" }, 1)]);
    expect(projection.identity).toBeUndefined();
  });
});

describe("late item completions", () => {
  const at = (
    type: CanonicalRuntimeEvent["type"],
    payload: CanonicalRuntimeEvent["payload"],
    seq: number,
  ): CanonicalRuntimeEvent => ({
    id: `e${seq}`,
    agentId: "a",
    type,
    createdAt: new Date(seq * 1000).toISOString(),
    payload,
  });

  const fold = (events: ReadonlyArray<CanonicalRuntimeEvent>) =>
    events.reduce(
      (projection, entry, index) => projectRuntimeEvent(projection, entry, index + 1),
      emptyRuntimeProjection("a"),
    );

  test("a completion arriving after the turn does not resurrect the session", () => {
    // A Task subagent can outlive the turn that dispatched it; its completion
    // landed minutes after turn.completed and put an idle session back to
    // running, while the terminal sat at a prompt.
    const projection = fold([
      at("turn.started", { objective: "Working" }, 1),
      at("turn.completed", { status: "completed", summary: "Done" }, 2),
      at("item.completed", { tool: "Task", summary: "subagent finished" }, 3),
    ]);
    expect(projection.state).toBe("idle");
  });

  test("but it still says what happened", () => {
    const projection = fold([
      at("turn.completed", { status: "completed", summary: "Done" }, 1),
      at("item.completed", { tool: "Task", summary: "subagent finished" }, 2),
    ]);
    expect(projection.task).toBe("subagent finished");
  });

  test("a completion inside a turn leaves the session running", () => {
    const projection = fold([
      at("turn.started", { objective: "Working" }, 1),
      at("item.started", { tool: "Bash", summary: "Using Bash" }, 2),
      at("item.completed", { tool: "Bash", summary: "Bash completed" }, 3),
    ]);
    expect(projection.state).toBe("running");
  });

  test("work beginning still means running, even from idle", () => {
    // item.started is the opposite case: it is news that work has begun.
    const projection = fold([
      at("turn.completed", { status: "completed", summary: "Done" }, 1),
      at("item.started", { tool: "Bash", summary: "Using Bash" }, 2),
    ]);
    expect(projection.state).toBe("running");
  });
});

describe("rate-limits.updated", () => {
  const at = (payload: CanonicalRuntimeEvent["payload"], seq: number): CanonicalRuntimeEvent => ({
    id: `e${seq}`,
    agentId: "a",
    type: "rate-limits.updated",
    createdAt: new Date(seq * 1000).toISOString(),
    payload,
  });
  const fold = (events: ReadonlyArray<CanonicalRuntimeEvent>) =>
    events.reduce(
      (projection, entry, index) => projectRuntimeEvent(projection, entry, index + 1),
      emptyRuntimeProjection("a"),
    );

  test("folds reported windows into the projection", () => {
    const projection = fold([
      at(
        {
          windows: [
            { id: "5h", label: "5-hour", usedPercent: 42, resetsAt: "2026-08-27T05:00:00.000Z" },
            { id: "weekly", label: "Weekly", usedPercent: 11, account: "personal" },
          ],
        },
        1,
      ),
    ]);
    expect(projection.rateLimits).toEqual([
      { id: "5h", label: "5-hour", usedPercent: 42, resetsAt: "2026-08-27T05:00:00.000Z" },
      { id: "weekly", label: "Weekly", usedPercent: 11, account: "personal" },
    ]);
  });

  test("the latest report replaces the previous one wholesale", () => {
    // Windows are a reading, not history: one that stopped being reported
    // has closed, and keeping it would show a limit that no longer exists.
    const projection = fold([
      at({ windows: [{ id: "5h", label: "5-hour", usedPercent: 42 }] }, 1),
      at({ windows: [{ id: "weekly", label: "Weekly", usedPercent: 90 }] }, 2),
    ]);
    expect(projection.rateLimits).toEqual([{ id: "weekly", label: "Weekly", usedPercent: 90 }]);
  });

  test("keeps the windows that parse and drops the ones that do not", () => {
    const projection = fold([
      at(
        {
          windows: [
            { id: "5h", label: "5-hour", usedPercent: 42 },
            { id: "no-percent", label: "Broken" },
            { label: "no id", usedPercent: 3 },
            "not a window",
            { id: "nan", label: "NaN", usedPercent: Number.NaN },
          ],
        },
        1,
      ),
    ]);
    expect(projection.rateLimits).toEqual([{ id: "5h", label: "5-hour", usedPercent: 42 }]);
  });

  test("a payload with no readable window list changes nothing", () => {
    const projection = fold([
      at({ windows: [{ id: "5h", label: "5-hour", usedPercent: 42 }] }, 1),
      at({ windows: "everything is fine" }, 2),
      at({}, 3),
    ]);
    expect(projection.rateLimits).toEqual([{ id: "5h", label: "5-hour", usedPercent: 42 }]);
    expect(projection.sequence).toBe(3);
  });

  test("a session that never hears one has no rate limits", () => {
    expect(fold([]).rateLimits).toBeUndefined();
  });
});

describe("settled requests", () => {
  const at = (
    type: CanonicalRuntimeEvent["type"],
    payload: CanonicalRuntimeEvent["payload"],
    seq: number,
  ): CanonicalRuntimeEvent => ({
    id: `e${seq}`,
    agentId: "a",
    type,
    createdAt: new Date(seq * 1000).toISOString(),
    payload,
  });
  const fold = (events: ReadonlyArray<CanonicalRuntimeEvent>) =>
    events.reduce(
      (projection, entry, index) => projectRuntimeEvent(projection, entry, index + 1),
      emptyRuntimeProjection("a"),
    );

  test("an answered request resumes the work it was blocking", () => {
    const projection = fold([
      at("session.state.changed", { state: "waiting", task: "Approval: Bash" }, 1),
      at("request.resolved", { status: "approved" }, 2),
    ]);
    expect(projection.state).toBe("running");
  });

  test("an expired one leaves the session where it was", () => {
    // Nobody answered, so the runtime is still sitting at the prompt. Claiming
    // "running" here reported blocked sessions as busy.
    const projection = fold([
      at("session.state.changed", { state: "waiting", task: "Resume from summary?" }, 1),
      at("user-input.resolved", { status: "expired" }, 2),
    ]);
    expect(projection.state).toBe("waiting");
  });

  test("either way the request stops being pending", () => {
    const projection = fold([
      at("user-input.requested", { kind: "user-input", question: "Which?" }, 1),
      at("user-input.resolved", { status: "expired" }, 2),
    ]);
    expect(projection.pendingRequest).toBeUndefined();
  });
});

describe("state authority", () => {
  const report = (
    seq: number,
    source: string,
    payload: CanonicalRuntimeEvent["payload"],
    atMs = seq * 1000,
  ): CanonicalRuntimeEvent => ({
    id: `e${seq}`,
    agentId: "a",
    type: "session.state.changed",
    createdAt: new Date(atMs).toISOString(),
    origin: { source, seq },
    payload,
  });

  const fold = (events: ReadonlyArray<CanonicalRuntimeEvent>) =>
    events.reduce(
      (projection, entry, index) => projectRuntimeEvent(projection, entry, index + 1),
      emptyRuntimeProjection("a"),
    );

  test("a live claim keeps another publisher's state report from landing", () => {
    // The herdr-vs-hooks race: the terminal observer claims waiting at a
    // prompt the hooks cannot see, then a delayed hook report says idle.
    const projection = fold([
      report(1, "herdr", {
        state: "waiting",
        task: "Resume from summary?",
        claim: { ttlMs: 60_000 },
      }),
      report(2, "claude-hooks", { state: "idle", task: "Ready" }),
    ]);
    expect(projection.state).toBe("waiting");
    expect(projection.task).toBe("Resume from summary?");
    expect(projection.stateAuthority?.source).toBe("herdr");
    // The suppressed report still advanced the fold's cursor.
    expect(projection.sequence).toBe(2);
  });

  test("the holder releases by reporting without a claim", () => {
    const projection = fold([
      report(1, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: 60_000 } }),
      report(2, "herdr", { state: "idle", task: "Ready for an instruction" }),
      report(3, "claude-hooks", { state: "running", task: "Working" }),
    ]);
    expect(projection.state).toBe("running");
    expect(projection.stateAuthority).toBeUndefined();
  });

  test("an expired claim decays, and the next stranger sweeps it out", () => {
    const projection = fold([
      report(1, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: 5_000 } }),
      // 7s later: past the 5s lease.
      report(2, "claude-hooks", { state: "idle", task: "Ready" }, 8_000),
    ]);
    expect(projection.state).toBe("idle");
    expect(projection.stateAuthority).toBeUndefined();
  });

  test("a competing claim while one is live is suppressed, not a takeover", () => {
    const projection = fold([
      report(1, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: 60_000 } }),
      report(2, "another-observer", { state: "error", task: "Broken", claim: { ttlMs: 60_000 } }),
    ]);
    expect(projection.state).toBe("waiting");
    expect(projection.stateAuthority?.source).toBe("herdr");
  });

  test("lifecycle events are positive evidence and pass through a claim", () => {
    // A turn starting means the prompt was answered in the terminal itself;
    // the claim guards opinions, not facts.
    const projection = fold([
      report(1, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: 60_000 } }),
      {
        id: "e2",
        agentId: "a",
        type: "turn.started",
        createdAt: new Date(2_000).toISOString(),
        origin: { source: "claude-hooks", seq: 9 },
        payload: { objective: "Fix the bug" },
      },
    ]);
    expect(projection.state).toBe("running");
  });

  test("a claim without an origin, or with an unreadable ttl, is no claim", () => {
    const unattributed = fold([
      {
        id: "e1",
        agentId: "a",
        type: "session.state.changed",
        createdAt: new Date(1_000).toISOString(),
        payload: { state: "waiting", task: "Prompt", claim: { ttlMs: 60_000 } },
      },
    ]);
    expect(unattributed.state).toBe("waiting");
    expect(unattributed.stateAuthority).toBeUndefined();
    const malformed = fold([
      report(1, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: -5 } }),
    ]);
    expect(malformed.stateAuthority).toBeUndefined();
  });

  test("the holder refreshing its claim extends the lease", () => {
    const projection = fold([
      report(1, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: 5_000 } }),
      report(2, "herdr", { state: "waiting", task: "Prompt", claim: { ttlMs: 5_000 } }, 4_000),
      // 8s: past the first lease's 6s expiry, inside the refreshed 9s one.
      report(3, "claude-hooks", { state: "idle", task: "Ready" }, 8_000),
    ]);
    expect(projection.state).toBe("waiting");
  });
});

describe("state authority release on resolution", () => {
  const at = (
    type: CanonicalRuntimeEvent["type"],
    payload: CanonicalRuntimeEvent["payload"],
    seq: number,
    source = "claude-hooks",
  ): CanonicalRuntimeEvent => ({
    id: `e${seq}`,
    agentId: "a",
    type,
    createdAt: new Date(seq * 1000).toISOString(),
    origin: { source, seq },
    payload,
  });

  const fold = (events: ReadonlyArray<CanonicalRuntimeEvent>) =>
    events.reduce(
      (projection, entry, index) => projectRuntimeEvent(projection, entry, index + 1),
      emptyRuntimeProjection("a"),
    );

  test("the holder resolving its request releases the claim", () => {
    const projection = fold([
      at("request.opened", { kind: "approval", tool: "Bash" }, 1),
      at(
        "session.state.changed",
        { state: "waiting", task: "Approval: Bash", claim: { ttlMs: 600_000 } },
        2,
      ),
      at("request.resolved", { status: "approved" }, 3),
    ]);
    expect(projection.state).toBe("running");
    expect(projection.stateAuthority).toBeUndefined();
  });

  test("a stranger's resolution leaves the claim standing", () => {
    const projection = fold([
      at(
        "session.state.changed",
        { state: "waiting", task: "Prompt", claim: { ttlMs: 600_000 } },
        1,
        "herdr",
      ),
      at("user-input.resolved", { status: "expired" }, 2, "someone-else"),
    ]);
    expect(projection.stateAuthority?.source).toBe("herdr");
  });
});
