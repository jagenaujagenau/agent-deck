import { describe, expect, test } from "bun:test";
import { blockedDetail } from "./Http";
import { pendingBlockFrom } from "./State";

const approval = {
  id: "req-1",
  tool: "Bash",
  detail: "rm -rf build",
  createdAt: "2026-08-26T00:00:00.000Z",
  expiresAt: "2026-08-26T00:10:00.000Z",
};

const question = {
  id: "req-2",
  question: "Which branch?",
  options: ["main", "dev"],
  createdAt: "2026-08-26T00:00:00.000Z",
  expiresAt: "2026-08-26T00:10:00.000Z",
};

describe("pendingBlockFrom", () => {
  test("a free agent is not blocked", () => {
    expect(pendingBlockFrom(undefined, undefined)).toBeUndefined();
  });

  test("a pending approval blocks, named by its tool", () => {
    expect(pendingBlockFrom(approval, undefined)).toEqual({ kind: "approval", tool: "Bash" });
  });

  test("a pending question blocks, named by its text", () => {
    expect(pendingBlockFrom(undefined, question)).toEqual({
      kind: "question",
      question: "Which branch?",
    });
  });

  test("an approval outranks a question when both are pending", () => {
    expect(pendingBlockFrom(approval, question)).toEqual({ kind: "approval", tool: "Bash" });
  });
});

describe("blockedDetail", () => {
  test("names the tool an approval is holding open", () => {
    expect(blockedDetail({ kind: "approval", tool: "Bash" })).toBe(
      "The agent is waiting for approval to run Bash",
    );
  });

  test("names the question the agent is waiting on", () => {
    expect(blockedDetail({ kind: "question", question: "Which branch?" })).toBe(
      "The agent is waiting for an answer to: Which branch?",
    );
  });
});
