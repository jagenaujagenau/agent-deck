import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConversationBacklog,
  readNewReasoning,
  type TranscriptCursor,
} from "./transcript-reasoning";

function transcript(...entries: unknown[]) {
  const path = join(mkdtempSync(join(tmpdir(), "agent-deck-transcript-")), "session.jsonl");
  writeFileSync(
    path,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
  );
  return path;
}

const thinking = (uuid: string, text: string) => ({
  type: "assistant",
  uuid,
  message: {
    content: [
      { type: "thinking", thinking: text },
      { type: "text", text: "visible" },
    ],
  },
});

describe("readNewReasoning", () => {
  test("the first pass seeds the cursor instead of replaying the backlog", () => {
    const path = transcript(thinking("a", "old thought"), thinking("b", "older thought"));
    const cursor: TranscriptCursor = {};

    expect(readNewReasoning(path, cursor, "s")).toEqual([]);
    expect(cursor.offset).toBeGreaterThan(0);
  });

  test("later passes return only what was appended since", () => {
    const path = transcript(thinking("a", "seeded"));
    const cursor: TranscriptCursor = {};
    readNewReasoning(path, cursor, "s");

    appendFileSync(path, `${JSON.stringify(thinking("b", "fresh thought"))}\n`);
    expect(readNewReasoning(path, cursor, "s").map((b) => b.text)).toEqual(["fresh thought"]);
    // Nothing new the next time around.
    expect(readNewReasoning(path, cursor, "s")).toEqual([]);
  });

  test("non-ASCII content does not desynchronise the byte cursor", () => {
    const path = transcript(thinking("a", "seeded"));
    const cursor: TranscriptCursor = {};
    readNewReasoning(path, cursor, "s");

    // Em dashes and arrows are multi-byte: a character-indexed cursor would slice mid-sequence and
    // hand JSON.parse garbage from here on.
    appendFileSync(
      path,
      `${JSON.stringify(thinking("b", "first — with arrows → and emoji 🎯"))}\n`,
    );
    appendFileSync(path, `${JSON.stringify(thinking("c", "second thought"))}\n`);

    expect(readNewReasoning(path, cursor, "s").map((b) => b.text)).toEqual([
      "first — with arrows → and emoji 🎯",
      "second thought",
    ]);
  });

  test("a half-written final line is left for the next pass", () => {
    const path = transcript(thinking("a", "seeded"));
    const cursor: TranscriptCursor = {};
    readNewReasoning(path, cursor, "s");

    const complete = JSON.stringify(thinking("b", "complete"));
    appendFileSync(path, `${complete}\n{"type":"assistant","uuid":"c","mess`);
    expect(readNewReasoning(path, cursor, "s").map((b) => b.text)).toEqual(["complete"]);

    appendFileSync(path, `age":{"content":[{"type":"thinking","thinking":"finished later"}]}}\n`);
    expect(readNewReasoning(path, cursor, "s").map((b) => b.text)).toEqual(["finished later"]);
  });

  test("ids are stable per thinking block so re-reads deduplicate at the bridge", () => {
    const path = transcript(thinking("a", "seeded"));
    const cursor: TranscriptCursor = {};
    readNewReasoning(path, cursor, "session-key");
    const beforeAppend = cursor.offset;
    appendFileSync(path, `${JSON.stringify(thinking("uuid-1", "thought"))}\n`);

    const first = readNewReasoning(path, cursor, "session-key");
    // Re-reading the same bytes must produce the same id, so a redelivery deduplicates at the bridge.
    const again = readNewReasoning(path, { offset: beforeAppend }, "session-key");

    expect(first.map((b) => b.id)).toEqual(["reasoning:session-key:uuid-1:0"]);
    expect(again.map((b) => b.id)).toEqual(first.map((b) => b.id));
  });

  test("a truncated or replaced transcript reseeds rather than reading a bogus offset", () => {
    const path = transcript(thinking("a", "before a fork"), thinking("b", "more"));
    const cursor: TranscriptCursor = {};
    readNewReasoning(path, cursor, "s");

    writeFileSync(path, `${JSON.stringify(thinking("c", "short"))}\n`);
    expect(readNewReasoning(path, cursor, "s")).toEqual([]);
    appendFileSync(path, `${JSON.stringify(thinking("d", "after reseed"))}\n`);
    expect(readNewReasoning(path, cursor, "s").map((b) => b.text)).toEqual(["after reseed"]);
  });

  test("entries without thinking, and a missing file, yield nothing", () => {
    const path = transcript(
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: [{ type: "text", text: "no thinking" }] } },
    );
    const cursor: TranscriptCursor = { offset: 0 };
    expect(readNewReasoning(path, cursor, "s")).toEqual([]);
    expect(readNewReasoning(join(path, "missing.jsonl"), {}, "s")).toEqual([]);
  });
});

describe("conversation sync", () => {
  test("reads what the terminal shows: typed messages and spoken replies, not tool traffic", () => {
    const path = transcript(
      { type: "user", uuid: "u1", message: { role: "user", content: "fix the flaky test" } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "On it." },
          ],
        },
      },
      // A tool result is fed back as a user entry; it is not something the person said.
      {
        type: "user",
        uuid: "u2",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        uuid: "u3",
        message: { role: "user", content: [{ type: "text", text: "thanks" }] },
      },
    );

    expect(readConversationBacklog(path, "s").messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "fix the flaky test"],
      ["assistant", "On it."],
      ["user", "thanks"],
    ]);
  });

  test("a background agent's report is the agent speaking, not the person", () => {
    const path = transcript({
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<task-notification>",
              "<task-id>abc123</task-id>",
              "<output-file>/tmp/tasks/abc123.output</output-file>",
              "<status>completed</status>",
              '<summary>Agent "Close the iOS feature gap" finished</summary>',
              "<note>Addressed to the model, not to a reader.</note>",
              "<result>Shipped build 202608261337.</result>",
              "<usage><subagent_tokens>434045</subagent_tokens></usage>",
              "</task-notification>",
            ].join("\n"),
          },
        ],
      },
    });

    expect(readConversationBacklog(path, "s").messages).toEqual([
      {
        id: "chat:s:u1",
        role: "assistant",
        text: "Shipped build 202608261337.",
        summary: 'Agent "Close the iOS feature gap" finished',
      },
    ]);
  });

  test("a Task result naming its subagent becomes a spawn, not conversation", () => {
    const path = transcript(
      {
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "launched" }],
        },
        toolUseResult: {
          isAsync: true,
          status: "async_launched",
          agentId: "ab39b2830758932e5",
          description: "Fix lint in apps/server",
        },
      },
      // A Bash result also carries toolUseResult, but names no agent.
      {
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }],
        },
        toolUseResult: { stdout: "ok", stderr: "" },
      },
    );

    const backlog = readConversationBacklog(path, "s");
    expect(backlog.spawns).toEqual([
      {
        id: "subagent-named:s:ab39b2830758932e5",
        subagentId: "ab39b2830758932e5",
        name: "Fix lint in apps/server",
      },
    ]);
    expect(backlog.messages).toEqual([]);
  });

  test("the backlog covers the whole file, unlike the reasoning cursor which starts at the end", () => {
    const path = transcript(
      { type: "user", uuid: "u1", message: { role: "user", content: "first" } },
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "reply" }] } },
    );

    expect(readConversationBacklog(path, "s").messages.length).toBe(2);
    expect(readNewReasoning(path, {}, "s")).toEqual([]);
  });

  test("message ids come from transcript uuids, so republishing cannot duplicate a turn", () => {
    const path = transcript({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "hello" },
    });
    expect(readConversationBacklog(path, "key").messages[0].id).toBe("chat:key:u1");
    expect(readConversationBacklog(path, "key").messages[0].id).toBe(
      readConversationBacklog(path, "key").messages[0].id,
    );
  });

  test("sidechain and meta entries are not part of the conversation", () => {
    const path = transcript(
      {
        type: "user",
        uuid: "m1",
        isMeta: true,
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      },
      { type: "user", uuid: "u1", message: { role: "user", content: "real message" } },
    );
    expect(readConversationBacklog(path, "s").messages.map((m) => m.text)).toEqual(["real message"]);
  });
});
