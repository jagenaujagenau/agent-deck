import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "./json-value";
import { readConversationBacklog, readNewTranscript } from "./transcript-reasoning";

function rollout(...entries: unknown[]) {
  const path = join(mkdtempSync(join(tmpdir(), "agent-deck-rollout-")), "rollout.jsonl");
  writeFileSync(
    path,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
  );
  return path;
}

// Shapes below mirror real rollout lines: {timestamp, type, payload}, with the
// conversation in response_item payloads and everything else around them.
const item = (payload: JsonValue) => ({
  timestamp: "2026-08-28T09:00:00.000Z",
  type: "response_item",
  payload,
});
const userItem = (text: string) =>
  item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantItem = (text: string) =>
  item({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
    phase: "commentary",
  });
const reasoningItem = (...summaries: string[]) =>
  item({
    type: "reasoning",
    summary: summaries.map((text) => ({ type: "summary_text", text })),
    content: null,
    encrypted_content: "gAAAAAB-opaque-cipher-bytes",
  });

function backlog(path: string) {
  return readConversationBacklog(path, "s", "codex");
}

describe("codex conversation", () => {
  test("user and assistant response items become the conversation", () => {
    const path = rollout(
      userItem("wire the settings screen to the store"),
      reasoningItem("Planning the store wiring"),
      assistantItem("Let's look at the store module first."),
      assistantItem("Done — the screen now reads from the store."),
    );

    expect(backlog(path).messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "wire the settings screen to the store"],
      ["assistant", "Let's look at the store module first."],
      ["assistant", "Done — the screen now reads from the store."],
    ]);
  });

  test("tool traffic, events, and session plumbing are not conversation", () => {
    const path = rollout(
      {
        timestamp: "t",
        type: "session_meta",
        payload: { id: "0199-aaaa", cwd: "/home/dev/example", originator: "codex_cli" },
      },
      { timestamp: "t", type: "turn_context", payload: { cwd: "/home/dev/example" } },
      { timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "hi" } },
      { timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "hello" } },
      item({
        type: "function_call",
        name: "shell",
        arguments: '{"command":["ls"]}',
        call_id: "call_1",
      }),
      item({ type: "function_call_output", call_id: "call_1", output: "src\ntest" }),
      item({ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" }),
      userItem("real question"),
    );

    expect(backlog(path).messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "real question"],
    ]);
  });

  test("harness-injected user items are plumbing, not the person", () => {
    const path = rollout(
      item({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions>\nsandboxed\n</permissions instructions>" }],
      }),
      userItem("<environment_context>\n  <cwd>/home/dev/example</cwd>\n</environment_context>"),
      userItem("<turn_aborted> The user interrupted the turn."),
      userItem("# AGENTS.md instructions for /home/dev/example\nBe tidy."),
      userItem("go for it"),
    );

    expect(backlog(path).messages.map((m) => [m.role, m.text])).toEqual([["user", "go for it"]]);
  });
});

describe("codex reasoning", () => {
  test("summary texts become reasoning blocks; an unsummarised item is nothing", () => {
    const path = rollout(
      reasoningItem(),
      reasoningItem("Weighing the two migration orders", "Choosing the reversible one"),
    );
    const read = readNewTranscript(path, { offset: 0 }, "s", "codex", undefined);

    expect(read.reasoning.map((b) => b.text)).toEqual([
      "Weighing the two migration orders",
      "Choosing the reversible one",
    ]);
    // Two summaries on one item keep their positions in the id, like Claude's parts do.
    expect(read.reasoning.map((b) => b.id.split(":").at(-1))).toEqual(["0", "1"]);
  });

  test("ids come from the item's own id when it has one", () => {
    const path = rollout(
      item({
        type: "reasoning",
        id: "rs_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        summary: [{ type: "summary_text", text: "Reading the failing test" }],
        encrypted_content: "gAAAAAB-opaque",
      }),
    );

    expect(readNewTranscript(path, { offset: 0 }, "s", "codex").reasoning.map((b) => b.id)).toEqual(
      ["reasoning:s:rs_0a1b2c3d4e5f60718293a4b5c6d7e8f9:0"],
    );
  });

  test("keyless lines are named by byte offset, so a re-read reproduces every id", () => {
    const path = rollout(userItem("first"), reasoningItem("a thought"), assistantItem("a reply"));
    const first = readNewTranscript(path, { offset: 0 }, "s", "codex");
    const again = readNewTranscript(path, { offset: 0 }, "s", "codex");

    expect(again).toEqual(first);
    const ids = [...first.messages.map((m) => m.id), ...first.reasoning.map((b) => b.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the live tail resumes mid-file without renaming earlier lines", () => {
    const path = rollout(userItem("seed"));
    const cursor = { offset: undefined };
    readNewTranscript(path, cursor, "s", "codex");

    appendFileSync(path, `${JSON.stringify(reasoningItem("fresh thought"))}\n`);
    const tailed = readNewTranscript(path, cursor, "s", "codex");
    const whole = readNewTranscript(path, { offset: 0 }, "s", "codex");

    expect(tailed.reasoning.map((b) => b.text)).toEqual(["fresh thought"]);
    expect(whole.reasoning).toEqual(tailed.reasoning);
  });
});

describe("runtime selection", () => {
  test("a claude transcript still reads exactly as before when no runtime is named", () => {
    const path = rollout(
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "thinking", thinking: "hm" }] },
      },
    );
    const read = readNewTranscript(path, { offset: 0 }, "key");

    expect(read.messages).toEqual([{ id: "chat:key:u1", role: "user", text: "hello" }]);
    expect(read.reasoning).toEqual([{ id: "reasoning:key:a1:0", text: "hm" }]);
  });

  test("a codex line read with the claude grammar is not conversation, and vice versa", () => {
    const codexPath = rollout(userItem("codex says hi"));
    const claudePath = rollout({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "claude says hi" },
    });

    expect(readConversationBacklog(codexPath, "s").messages).toEqual([]);
    expect(readConversationBacklog(claudePath, "s", "codex").messages).toEqual([]);
  });
});
