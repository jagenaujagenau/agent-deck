import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialCodexScanState, parseClaudeUsageLine, parseCodexUsageLine, scanClaudeUsage } from "./transcriptUsage";

function line(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant", timestamp: "2026-08-24T00:00:00.000Z", sessionId: "s1", requestId: "r1", cwd: "/work/deck",
    message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 3 } },
    ...overrides,
  });
}

describe("Claude transcript usage", () => {
  test("keeps token facets disjoint", () => {
    const parsed = parseClaudeUsageLine(line());
    expect(parsed?.tokens).toBe(38);
    expect([parsed?.uncached_input_tokens, parsed?.cached_input_tokens, parsed?.cache_creation_tokens, parsed?.output_tokens]).toEqual([10, 20, 5, 3]);
  });

  test("deduplicates copied messages globally across transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentdeck-usage-"));
    await mkdir(join(root, "a"));
    await mkdir(join(root, "b"));
    await writeFile(join(root, "a", "one.jsonl"), `${line()}\n${line()}\n`);
    await writeFile(join(root, "b", "two.jsonl"), `${line({ sessionId: "fork" })}\n${line({ requestId: "r2", message: { id: "m2", model: "claude-opus-5", usage: { output_tokens: 7 } } })}\n`);
    const result = await scanClaudeUsage("2026-01-01T00:00:00.000Z", root);
    expect(result.rows.map((row) => row.tokens)).toEqual([38, 7]);
    expect(result.duplicates).toBe(2);
  });
});

describe("Codex transcript usage", () => {
  test("uses last usage deltas without double-counting cached input", () => {
    const state = initialCodexScanState();
    parseCodexUsageLine(JSON.stringify({ type: "session_meta", timestamp: "2026-08-24T00:00:00Z", payload: { id: "cx1", cwd: "/work/deck" } }), state);
    parseCodexUsageLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5", cwd: "/work/deck" } }), state);
    const tokenLine = JSON.stringify({ timestamp: "2026-08-24T00:00:02Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 10 } } } });
    const parsed = parseCodexUsageLine(tokenLine, state);
    expect(parsed?.tokens).toBe(120);
    expect([parsed?.uncached_input_tokens, parsed?.cached_input_tokens, parsed?.output_tokens, parsed?.reasoning_tokens]).toEqual([40, 60, 20, 10]);
    expect(parseCodexUsageLine(tokenLine, state)).toBeUndefined();
  });

  test("suppresses copied history at the start of a fork", () => {
    const state = initialCodexScanState();
    parseCodexUsageLine(JSON.stringify({ type: "session_meta", timestamp: "2026-08-24T00:00:00Z", payload: { id: "fork", forked_from_id: "parent" } }), state);
    parseCodexUsageLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }), state);
    const usage = (timestamp: string, output: number) => JSON.stringify({ timestamp, payload: { type: "token_count", info: { last_token_usage: { output_tokens: output } } } });
    expect(parseCodexUsageLine(usage("2026-08-24T00:00:00.100Z", 10), state)).toBeUndefined();
    expect(parseCodexUsageLine(usage("2026-08-24T00:00:02.000Z", 5), state)?.tokens).toBe(5);
  });
});
