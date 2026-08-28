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
  const at = (
    payload: CanonicalRuntimeEvent["payload"],
    seq: number,
  ): CanonicalRuntimeEvent => ({
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
