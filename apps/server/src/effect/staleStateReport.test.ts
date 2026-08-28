import { describe, expect, test } from "bun:test";
import { isStaleStateReport } from "./State";

const report = (seq: number, agentId = "agent-1", source = "claude-hooks") => ({
  type: "session.state.changed" as const,
  agentId,
  origin: { source, seq },
});

describe("isStaleStateReport", () => {
  test("accepts advancing sequences and drops what falls behind", () => {
    const seen = new Map<string, number>();
    expect(isStaleStateReport(seen, report(1))).toBe(false);
    expect(isStaleStateReport(seen, report(3))).toBe(false);
    // The daemon publishing a state it loaded before the hook advanced it.
    expect(isStaleStateReport(seen, report(2))).toBe(true);
    expect(isStaleStateReport(seen, report(3))).toBe(true);
    expect(isStaleStateReport(seen, report(4))).toBe(false);
  });

  test("orders per source, so different publishers never mask each other", () => {
    const seen = new Map<string, number>();
    expect(isStaleStateReport(seen, report(5, "agent-1", "claude-hooks"))).toBe(false);
    expect(isStaleStateReport(seen, report(1, "agent-1", "another-source"))).toBe(false);
  });

  test("orders per agent, so one session never masks another", () => {
    const seen = new Map<string, number>();
    expect(isStaleStateReport(seen, report(5, "agent-1"))).toBe(false);
    expect(isStaleStateReport(seen, report(1, "agent-2"))).toBe(false);
  });

  test("a report with no origin always lands, as it always has", () => {
    const seen = new Map<string, number>();
    expect(isStaleStateReport(seen, report(9))).toBe(false);
    expect(
      isStaleStateReport(seen, { type: "session.state.changed", agentId: "agent-1" }),
    ).toBe(false);
  });

  test("only state reports are guarded; item facts are append-only history", () => {
    const seen = new Map<string, number>();
    expect(isStaleStateReport(seen, report(5))).toBe(false);
    expect(
      isStaleStateReport(seen, {
        type: "item.completed",
        agentId: "agent-1",
        origin: { source: "claude-hooks", seq: 2 },
      }),
    ).toBe(false);
  });
});
