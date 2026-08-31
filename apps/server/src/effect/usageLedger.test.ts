import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlClient } from "effect/unstable/sql";
import { BridgeSchema } from "./Schema";
import {
  emptyTranscriptCache,
  makeUsageLedger,
  runtimeFor,
  usageNumber,
  usageRise,
} from "./UsageLedger";
import type { AgentRecord } from "./State";

/**
 * What the deck believes it has spent.
 *
 * ADR-0001 separates Processed Usage from Context Usage and forbids
 * inferring one from the other; the rule that actually keeps the books
 * honest is the high-water cursor, which used to live as twenty lines in
 * the middle of `heartbeat` where no test could reach it without sending
 * one.
 */

const withLedger = <A>(body: (ledger: ReturnType<typeof makeUsageLedger>) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ledger = makeUsageLedger(
      { sql, now: () => new Date().toISOString() },
      yield* emptyTranscriptCache(),
    );
    return yield* body(ledger);
  }).pipe(
    Effect.provide(BridgeSchema),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.runPromise,
  );

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a1",
  name: "Claude Code",
  project: "deck",
  model: "claude",
  runtime: "claude",
  state: "running",
  task: "",
  tokens: 0,
  processedTokens: 0,
  costUsd: 0,
  lastSeenAt: new Date().toISOString(),
  events: [],
  ...overrides,
});

describe("usageRise", () => {
  test("a first report is all rise", () => {
    expect(usageRise({ tokens: 500, costUsd: 0.25 }, undefined)).toEqual({
      tokens: 500,
      costUsd: 0.25,
    });
  });

  test("re-reporting the same totals adds nothing", () => {
    // The whole reason the cursor exists: a runtime heartbeats its running
    // totals every fifteen seconds, and the deck must count them once.
    expect(usageRise({ tokens: 500, costUsd: 0.25 }, { tokens: 500, costUsd: 0.25 })).toEqual({
      tokens: 0,
      costUsd: 0,
    });
  });

  test("only the rise is counted", () => {
    expect(usageRise({ tokens: 800, costUsd: 0.4 }, { tokens: 500, costUsd: 0.25 })).toEqual({
      tokens: 300,
      costUsd: 0.4 - 0.25,
    });
  });

  test("a figure that went backwards adds nothing rather than a negative", () => {
    // A runtime restarting its own accounting must not subtract from what
    // the deck already knows it spent.
    expect(usageRise({ tokens: 10, costUsd: 0 }, { tokens: 500, costUsd: 0.25 })).toEqual({
      tokens: 0,
      costUsd: 0,
    });
  });
});

describe("the ledger over heartbeats", () => {
  test("a session heartbeating its running totals is counted once", async () => {
    const total = await withLedger((ledger) =>
      Effect.gen(function* () {
        yield* ledger.record(agent({ processedTokens: 1_000, costUsd: 0.1 }));
        yield* ledger.record(agent({ processedTokens: 1_000, costUsd: 0.1 }));
        yield* ledger.record(agent({ processedTokens: 1_500, costUsd: 0.2 }));
        return yield* ledger.total();
      }),
    );
    expect(total.tokens).toBe(1_500);
    expect(total.cost_usd).toBeCloseTo(0.2, 10);
  });

  test("a restarted runtime cannot rewind the deck's history", async () => {
    const total = await withLedger((ledger) =>
      Effect.gen(function* () {
        yield* ledger.record(agent({ processedTokens: 5_000, costUsd: 1 }));
        // The same session comes back reporting from zero.
        yield* ledger.record(agent({ processedTokens: 0, costUsd: 0 }));
        yield* ledger.record(agent({ processedTokens: 200, costUsd: 0.05 }));
        return yield* ledger.total();
      }),
    );
    // The mark only moves up, so the second run's small totals add nothing
    // until they pass what was already spent.
    expect(total.tokens).toBe(5_000);
  });

  test("sessions are counted apart", async () => {
    const total = await withLedger((ledger) =>
      Effect.gen(function* () {
        yield* ledger.record(agent({ id: "a1", processedTokens: 100 }));
        yield* ledger.record(agent({ id: "a2", processedTokens: 700 }));
        return yield* ledger.total();
      }),
    );
    expect(total.tokens).toBe(800);
  });

  test("processed usage falls back to context usage, never the other way", async () => {
    const total = await withLedger((ledger) =>
      Effect.gen(function* () {
        // A runtime that reports only its context pressure: the deck bills
        // that figure once rather than inventing a processed total.
        yield* ledger.record(agent({ processedTokens: undefined, tokens: 400 }));
        return yield* ledger.total();
      }),
    );
    expect(total.tokens).toBe(400);
  });

  test("what a range holds is what was spent inside it", async () => {
    const { usage, activity } = await withLedger((ledger) =>
      Effect.gen(function* () {
        yield* ledger.record(agent({ processedTokens: 900 }));
        yield* ledger.recordActivity(agent(), {
          id: "e1",
          kind: "tool",
          summary: "Edit",
          createdAt: new Date().toISOString(),
        });
        return yield* ledger.since("2000-01-01T00:00:00.000Z");
      }),
    );
    expect(usage[0]?.tokens).toBe(900);
    expect(usage[0]?.runtime).toBe("claude");
    expect(activity[0]?.kind).toBe("tool");
  });
});

describe("attribution", () => {
  test("the runtime's own word wins, and a name is the fallback", () => {
    expect(runtimeFor({ name: "Anything", runtime: "opencode" })).toBe("opencode");
    expect(runtimeFor({ name: "Claude Code", runtime: undefined })).toBe("claude");
    expect(runtimeFor({ name: "Codex · x", runtime: undefined })).toBe("codex");
    expect(runtimeFor({ name: "Something else", runtime: undefined })).toBe("other");
  });

  test("a figure that is not a number falls back rather than being billed", () => {
    expect(usageNumber(Number.NaN, 7)).toBe(7);
    expect(usageNumber(null, 7)).toBe(7);
    expect(usageNumber(undefined, 7)).toBe(7);
    expect(usageNumber(0, 7)).toBe(0);
  });
});
