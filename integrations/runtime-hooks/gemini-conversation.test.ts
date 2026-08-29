import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiConversation } from "./gemini-conversation";

/** A conversation file in the exact shape Gemini CLI 0.57.0's recordMessage writes. */
const conversation = {
  sessionId: "g-1",
  lastUpdated: "2026-08-29T10:00:02.000Z",
  messages: [
    { id: "m1", timestamp: "2026-08-29T10:00:00.000Z", type: "user", content: "add a health endpoint" },
    {
      id: "m2",
      timestamp: "2026-08-29T10:00:01.000Z",
      type: "gemini",
      content: "On it.",
      model: "gemini-2.5-pro",
      thoughts: [
        { subject: "Plan", description: "Add a route, then a test.", timestamp: "2026-08-29T10:00:00.500Z" },
        { subject: "", description: "The router lives in app.ts.", timestamp: "2026-08-29T10:00:00.700Z" },
      ],
      tokens: { input: 0, prompt: 1200, candidates: 300, total: 1500, cached: 400, thoughts: 80, tool: 0 },
    },
    {
      id: "m3",
      timestamp: "2026-08-29T10:00:02.000Z",
      type: "gemini",
      content: "Done.",
      model: "gemini-2.5-pro",
      tokens: { input: 0, prompt: 2100, candidates: 150, total: 2250, cached: 900, thoughts: 0, tool: 0 },
    },
  ],
};

/** A fixture document: the writer's real shape, or something deliberately alien. */
type FixtureDocument = typeof conversation | { messages: string } | number[];

const write = (value: FixtureDocument): string => {
  const path = join(mkdtempSync(join(tmpdir(), "gemini-chat-")), "chat.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};

describe("readGeminiConversation", () => {
  test("usage: the newest prompt+cache is context, totals accumulate", () => {
    const read = readGeminiConversation(write(conversation), "s1");
    expect(read.contextTokens).toBe(3000);
    expect(read.processedTokens).toBe(3750);
    expect(read.model).toBe("gemini-2.5-pro");
  });

  test("thoughts get stable message-derived ids and keep their subjects", () => {
    const read = readGeminiConversation(write(conversation), "s1");
    expect(read.thoughts.map((thought) => thought.id)).toEqual([
      "reasoning:s1:m2:0",
      "reasoning:s1:m2:1",
    ]);
    expect(read.thoughts[0]?.text).toBe("Plan\nAdd a route, then a test.");
    expect(read.thoughts[1]?.text).toBe("The router lives in app.ts.");
  });

  test("re-reading yields identical ids, so republishing collapses at the bridge", () => {
    const path = write(conversation);
    expect(readGeminiConversation(path, "s1")).toEqual(readGeminiConversation(path, "s1"));
  });

  test("a missing, unreadable, or alien file is an empty read, never a throw", () => {
    expect(readGeminiConversation("/nonexistent/chat.json", "s1").processedTokens).toBe(0);
    expect(readGeminiConversation(write({ messages: "nope" }), "s1").thoughts).toEqual([]);
    expect(readGeminiConversation(write([1, 2, 3]), "s1").contextTokens).toBe(0);
  });
});
