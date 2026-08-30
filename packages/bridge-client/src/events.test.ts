import { describe, expect, test } from "bun:test";
import {
  conversationEntries,
  mergeSessionEvents,
  reasoningEvents,
  terminalEvents,
  turnThreads,
} from "./events";
import type { AgentEvent } from "./types";

const at = (second: number) => `2026-08-28T10:00:${String(second).padStart(2, "0")}.000Z`;

const event = (overrides: Partial<AgentEvent> & { id: string }): AgentEvent => ({
  kind: "output",
  summary: "Response",
  createdAt: at(0),
  ...overrides,
});

describe("mergeSessionEvents", () => {
  test("the live copy wins, but the snapshot's clipped detail is restored from history", () => {
    const full = event({ id: "e", detail: "a long message that history holds in full" });
    const clipped = event({ id: "e", detail: "a long message…" });
    const merged = mergeSessionEvents([full], [clipped]);
    expect(merged[0]?.detail).toBe("a long message that history holds in full");
  });

  test("a genuine revision to shorter text still takes the live copy", () => {
    const old = event({ id: "e", detail: "the original words" });
    const revised = event({ id: "e", detail: "rewritten" });
    expect(mergeSessionEvents([old], [revised])[0]?.detail).toBe("rewritten");
  });

  test("command and diff dropped by the snapshot come back from history", () => {
    const full = event({ id: "e", kind: "tool", summary: "Bash", command: "ls -la", diff: "+x" });
    const stripped = event({ id: "e", kind: "tool", summary: "Bash" });
    const merged = mergeSessionEvents([full], [stripped]);
    expect(merged[0]?.command).toBe("ls -la");
    expect(merged[0]?.diff).toBe("+x");
  });

  test("the result is ordered by createdAt across both sources", () => {
    const merged = mergeSessionEvents(
      [event({ id: "b", createdAt: at(2) })],
      [event({ id: "a", createdAt: at(1) }), event({ id: "c", createdAt: at(3) })],
    );
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("conversationEntries", () => {
  test("user events and agent responses interleave, oldest first", () => {
    const entries = conversationEntries([
      event({ id: "2", detail: "Sure, on it.", createdAt: at(2) }),
      event({
        id: "1",
        kind: "user",
        summary: "Message",
        detail: "Fix the test",
        createdAt: at(1),
      }),
    ]);
    expect(entries.map((entry) => entry.role)).toEqual(["user", "agent"]);
    expect(entries[0]?.content).toBe("Fix the test");
  });

  test("the same prompt arriving twice within seconds collapses to one bubble", () => {
    const entries = conversationEntries([
      event({ id: "hook", kind: "user", summary: "Message", detail: "Do it", createdAt: at(1) }),
      event({
        id: "transcript",
        kind: "user",
        summary: "Message",
        detail: "Do it",
        createdAt: at(3),
      }),
    ]);
    expect(entries).toHaveLength(1);
  });

  test("the same words typed again much later are a real second message", () => {
    const entries = conversationEntries([
      event({ id: "a", kind: "user", summary: "Message", detail: "again", createdAt: at(1) }),
      event({ id: "b", kind: "user", summary: "Message", detail: "again", createdAt: at(31) }),
    ]);
    expect(entries).toHaveLength(2);
  });

  test("a subagent's completion speaks in the conversation despite carrying a tool", () => {
    const entries = conversationEntries([
      event({ id: "s", tool: "Task", subagentId: "child", detail: "All done, report follows." }),
    ]);
    expect(entries[0]?.role).toBe("agent");
  });

  test("a raw task-notification never renders as the person speaking", () => {
    const entries = conversationEntries([
      event({
        id: "n",
        kind: "user",
        summary: "Message",
        detail: "<task-notification>\n<task-id>x</task-id>\n</task-notification>",
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  test("tool chatter stays out of the chat", () => {
    const entries = conversationEntries([
      event({ id: "t", kind: "tool", summary: "Bash", command: "ls" }),
      event({ id: "o", summary: "Edit completed" }),
    ]);
    expect(entries).toHaveLength(0);
  });
});

describe("tabs", () => {
  test("reasoning is thoughts with words, oldest first", () => {
    const events = [
      event({
        id: "2",
        kind: "thought",
        summary: "Reasoning",
        detail: "then this",
        createdAt: at(2),
      }),
      event({
        id: "1",
        kind: "thought",
        summary: "Reasoning",
        detail: "first this",
        createdAt: at(1),
      }),
      event({ id: "3", kind: "thought", summary: "Reasoning", detail: " ", createdAt: at(3) }),
    ];
    expect(reasoningEvents(events).map((item) => item.id)).toEqual(["1", "2"]);
  });

  test("the terminal is every event carrying a command", () => {
    const events = [
      event({ id: "b", kind: "tool", summary: "Bash", command: "bun test", createdAt: at(2) }),
      event({ id: "a", kind: "tool", summary: "Bash", command: "ls", createdAt: at(1) }),
      event({ id: "x", kind: "tool", summary: "Edit" }),
    ];
    expect(terminalEvents(events).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("turnThreads", () => {
  test("a user event opens a thread; its work follows it", () => {
    const threads = turnThreads([
      event({
        id: "u1",
        kind: "user",
        summary: "Message",
        detail: "fix it",
        createdAt: at(1),
        turnId: "t1",
      }),
      event({
        id: "w1",
        kind: "tool",
        summary: "Bash",
        command: "bun test",
        createdAt: at(2),
        turnId: "t1",
      }),
      event({
        id: "u2",
        kind: "user",
        summary: "Message",
        detail: "now ship it",
        createdAt: at(3),
        turnId: "t2",
      }),
      event({ id: "w2", summary: "Response", detail: "shipped", createdAt: at(4), turnId: "t2" }),
    ]);
    expect(threads.map((thread) => thread.events.length)).toEqual([2, 2]);
    expect(threads.map((thread) => thread.turnId)).toEqual(["t1", "t2"]);
  });

  test("a turnId change splits threads even without a user line", () => {
    const threads = turnThreads([
      event({ id: "a", summary: "Response", detail: "one", createdAt: at(1), turnId: "t1" }),
      event({ id: "b", summary: "Response", detail: "two", createdAt: at(2), turnId: "t2" }),
    ]);
    expect(threads).toHaveLength(2);
  });

  test("untagged events stay with the thread they follow", () => {
    const threads = turnThreads([
      event({
        id: "u",
        kind: "user",
        summary: "Message",
        detail: "go",
        createdAt: at(1),
        turnId: "t1",
      }),
      event({ id: "r", kind: "thought", summary: "Reasoning", detail: "hm", createdAt: at(2) }),
      event({ id: "o", summary: "Response", detail: "done", createdAt: at(3), turnId: "t1" }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.events).toHaveLength(3);
  });

  test("a runtime that never tags reads as user-delimited threads", () => {
    const threads = turnThreads([
      event({ id: "u1", kind: "user", summary: "Message", detail: "one", createdAt: at(1) }),
      event({ id: "o1", summary: "Response", detail: "a", createdAt: at(2) }),
      event({ id: "u2", kind: "user", summary: "Message", detail: "two", createdAt: at(3) }),
      event({ id: "o2", summary: "Response", detail: "b", createdAt: at(4) }),
    ]);
    expect(threads).toHaveLength(2);
  });
});
