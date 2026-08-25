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
  const at = (type: string, payload: Record<string, unknown>, seq: number) => ({
    id: `e${seq}`,
    agentId: "a",
    type,
    createdAt: new Date(seq * 1000).toISOString(),
    payload,
  });

  const fold = (events: ReadonlyArray<ReturnType<typeof at>>) =>
    events.reduce(
      (projection, event, index) => projectRuntimeEvent(projection, event as never, index + 1),
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
