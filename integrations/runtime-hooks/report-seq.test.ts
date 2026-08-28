import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextReportSeq, type ReportCounter } from "./report-seq";

let directory: string;
let statePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-deck-report-seq-"));
  statePath = join(directory, "agent.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("nextReportSeq", () => {
  test("starts a fresh session at 1", () => {
    const state: ReportCounter = {};
    expect(nextReportSeq(statePath, state)).toBe(1);
    expect(state.reportSeq).toBe(1);
  });

  test("counts up across calls in one process", () => {
    const state: ReportCounter = {};
    nextReportSeq(statePath, state);
    writeFileSync(statePath, JSON.stringify(state));
    nextReportSeq(statePath, state);
    writeFileSync(statePath, JSON.stringify(state));
    expect(nextReportSeq(statePath, state)).toBe(3);
  });

  test("adopts a higher persisted count the other publisher wrote", () => {
    // This process last saw 2, but the daemon has since published up to 9;
    // the next report must land after both.
    writeFileSync(statePath, JSON.stringify({ reportSeq: 9 }));
    const state: ReportCounter = { reportSeq: 2 };
    expect(nextReportSeq(statePath, state)).toBe(10);
  });

  test("keeps its own count ahead of a stale file", () => {
    writeFileSync(statePath, JSON.stringify({ reportSeq: 3 }));
    const state: ReportCounter = { reportSeq: 8 };
    expect(nextReportSeq(statePath, state)).toBe(9);
  });

  test("survives a corrupt state file", () => {
    writeFileSync(statePath, "not json");
    const state: ReportCounter = { reportSeq: 4 };
    expect(nextReportSeq(statePath, state)).toBe(5);
  });
});
