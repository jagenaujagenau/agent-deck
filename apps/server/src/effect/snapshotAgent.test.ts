import { describe, expect, test } from "bun:test";
import {
  OFFLINE_AFTER_ACTIVE_MS,
  OFFLINE_AFTER_IDLE_MS,
  authorityLive,
  renderSnapshotAgent,
  snapshotRateLimits,
  type AgentRecord,
  type SnapshotAgent,
} from "./State";
import type { RuntimeProjection } from "@agent-control-dashboard/agent-adapter";

const heartbeatWindows = [{ id: "5h", label: "5-hour", usedPercent: 40 }];
const projectedWindows = [
  { id: "5h", label: "5-hour", usedPercent: 63, resetsAt: "2026-08-27T05:00:00.000Z" },
];

describe("snapshotRateLimits", () => {
  test("projected rate limits win when the runtime has reported them", () => {
    expect(snapshotRateLimits({ rateLimits: projectedWindows }, heartbeatWindows)).toEqual(
      projectedWindows,
    );
  });

  test("falls back to the heartbeat when the projection has never heard one", () => {
    expect(snapshotRateLimits({ rateLimits: undefined }, heartbeatWindows)).toEqual(
      heartbeatWindows,
    );
    expect(snapshotRateLimits(undefined, heartbeatWindows)).toEqual(heartbeatWindows);
  });

  test("a runtime that reported no open windows is believed", () => {
    // An empty report is a statement, not silence: every window closed.
    expect(snapshotRateLimits({ rateLimits: [] }, heartbeatWindows)).toEqual([]);
  });

  test("no source at all renders no rate limits", () => {
    expect(snapshotRateLimits(undefined, undefined)).toBeUndefined();
  });
});

describe("the snapshot agent", () => {
  test("carries the runtime the heartbeat declared", () => {
    // The phone and watch were guessing the harness from id prefixes on the
    // claim that the wire had no runtime field. It does: the snapshot agent
    // is the stored record spread whole, and the stored record keeps
    // `runtime` from the heartbeat.
    const agent: SnapshotAgent = {
      id: "agent-1",
      name: "Claude · fx",
      project: "fx",
      model: "claude",
      runtime: "claude",
      state: "idle",
      task: "Ready",
      tokens: 0,
      costUsd: 0,
      lastSeenAt: "2026-08-27T00:00:00.000Z",
      events: [],
    };
    expect(JSON.parse(JSON.stringify(agent)).runtime).toBe("claude");
  });
});

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const since = (ms: number) => new Date(NOW - ms).toISOString();

const record = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a1",
  name: "Claude Code",
  project: "deck",
  model: "claude",
  state: "running",
  task: "Using Edit",
  tokens: 100,
  costUsd: 0.5,
  lastSeenAt: since(1_000),
  events: [],
  ...overrides,
});

const projected = (overrides: Partial<RuntimeProjection> = {}): RuntimeProjection =>
  // SAFETY: a projection carries more fields than any one case needs; the
  // fold reads only those set here, so a case states its own inputs and the
  // rest are the zero values a fresh projection would carry anyway.
  ({
    sequence: 7,
    state: "running",
    task: "Running tests",
    usageKnown: false,
    contextTokens: 0,
    processedTokens: 0,
    ...overrides,
  }) as RuntimeProjection;

describe("renderSnapshotAgent", () => {
  test("a canonical session's projection is believed over its heartbeat", () => {
    const item = renderSnapshotAgent(
      record({ runtimeProtocol: "canonical-v1", tokens: 0 }),
      projected({ usageKnown: true, contextTokens: 220_100, processedTokens: 900_000 }),
      {},
      NOW,
    );
    // The gate this replaced threw away the better number: a heartbeat
    // reporting 0 tokens for a session whose projection had counted 220,100.
    expect(item.tokens).toBe(220_100);
    expect(item.processedTokens).toBe(900_000);
    expect(item.task).toBe("Running tests");
    expect(item.projectionSequence).toBe(7);
  });

  test("a session that never registered keeps its heartbeat's word", () => {
    // Without canonical-v1 the projection is not this session's to apply.
    const item = renderSnapshotAgent(
      record({ tokens: 42 }),
      projected({ usageKnown: true, contextTokens: 999 }),
      {},
      NOW,
    );
    expect(item.tokens).toBe(42);
    expect(item.projectionSequence).toBeUndefined();
  });

  test("a number that is not one falls back rather than reaching a card", () => {
    const item = renderSnapshotAgent(
      record({ tokens: Number.NaN, processedTokens: Number.NaN, costUsd: Number.NaN }),
      undefined,
      {},
      NOW,
    );
    expect(item.tokens).toBe(0);
    expect(item.costUsd).toBe(0);
    expect(Number.isNaN(item.processedTokens ?? 0)).toBe(false);
  });

  test("silence past the grace is offline, and the grace depends on what it was doing", () => {
    const quietActive = renderSnapshotAgent(
      record({ lastSeenAt: since(OFFLINE_AFTER_ACTIVE_MS + 1_000) }),
      undefined,
      {},
      NOW,
    );
    expect(quietActive.state).toBe("offline");
    // An idle session legitimately goes quiet: the same silence is not offline.
    const quietIdle = renderSnapshotAgent(
      record({ state: "idle", lastSeenAt: since(OFFLINE_AFTER_ACTIVE_MS + 1_000) }),
      undefined,
      {},
      NOW,
    );
    expect(quietIdle.state).toBe("idle");
    const longQuietIdle = renderSnapshotAgent(
      record({ state: "idle", lastSeenAt: since(OFFLINE_AFTER_IDLE_MS + 1_000) }),
      undefined,
      {},
      NOW,
    );
    expect(longQuietIdle.state).toBe("offline");
  });

  test("the projected state decides which grace the silence is measured against", () => {
    // The heartbeat says running, the projection says idle: idle's grace applies.
    const item = renderSnapshotAgent(
      record({
        runtimeProtocol: "canonical-v1",
        state: "running",
        lastSeenAt: since(OFFLINE_AFTER_ACTIVE_MS + 1_000),
      }),
      projected({ state: "idle" }),
      {},
      NOW,
    );
    expect(item.state).toBe("idle");
  });

  test("a demo session is never called offline", () => {
    const item = renderSnapshotAgent(
      record({ isDemo: true, lastSeenAt: since(OFFLINE_AFTER_IDLE_MS * 10) }),
      undefined,
      {},
      NOW,
    );
    // Nothing is heartbeating it; going quiet is what it does.
    expect(item.state).toBe("running");
  });

  test("a live claim is provenance; an expired one is nobody's", () => {
    const authority = { source: "claude-hooks", expiresAt: new Date(NOW + 30_000).toISOString() };
    const live = renderSnapshotAgent(
      record({ runtimeProtocol: "canonical-v1" }),
      projected({ stateAuthority: authority }),
      {},
      NOW,
    );
    expect(live.stateAuthority).toEqual(authority);
    const expired = renderSnapshotAgent(
      record({ runtimeProtocol: "canonical-v1" }),
      projected({
        stateAuthority: { source: "claude-hooks", expiresAt: new Date(NOW - 1).toISOString() },
      }),
      {},
      NOW,
    );
    // ADR-0002: the clock releases a holder that died.
    expect(expired.stateAuthority).toBeUndefined();
  });

  test("a registered identity renames the session; an absent one leaves it alone", () => {
    const named = renderSnapshotAgent(
      record({ runtimeProtocol: "canonical-v1" }),
      projected({
        identity: {
          name: "Codex",
          project: "orbital",
          model: "gpt-5",
          capabilities: ["prompt"],
        },
      }),
      {},
      NOW,
    );
    expect([named.name, named.project, named.model]).toEqual(["Codex", "orbital", "gpt-5"]);
    expect(named.capabilities).toEqual(["prompt"]);
    const unnamed = renderSnapshotAgent(
      record({ runtimeProtocol: "canonical-v1" }),
      projected(),
      {},
      NOW,
    );
    expect(unnamed.name).toBe("Claude Code");
  });

  test("the card window is the newest events, newest first", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `e${index}`,
      kind: "tool" as const,
      summary: `step ${index}`,
      createdAt: since(40_000 - index),
    }));
    const item = renderSnapshotAgent(record({ events }), undefined, {}, NOW);
    expect(item.events.length).toBeLessThanOrEqual(24);
    expect(item.events[0]?.id).toBe("e39");
  });
});

describe("authorityLive", () => {
  test("a claim outlives its holder only until its own expiry", () => {
    const future = { source: "herdr", expiresAt: new Date(NOW + 1).toISOString() };
    expect(authorityLive(future, NOW)).toEqual(future);
    expect(
      authorityLive({ source: "herdr", expiresAt: new Date(NOW).toISOString() }, NOW),
    ).toBeUndefined();
    expect(authorityLive(undefined, NOW)).toBeUndefined();
  });
});
