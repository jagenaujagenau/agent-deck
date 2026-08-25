import { describe, expect, test } from "bun:test";
import {
  canonicalLifecycleEvent,
  shouldRequestRemoteApproval,
  shouldUseAgentDeckApproval,
} from "./lifecycle";

describe("canonicalLifecycleEvent", () => {
  test.each([
    ["SessionEnd", "SessionEnd"],
    ["sessionEnd", "SessionEnd"],
    ["session_end", "SessionEnd"],
    ["userPromptSubmit", "UserPromptSubmit"],
    ["PreToolUse", "PreToolUse"],
    ["post_tool_use_failure", "PostToolUseFailure"],
  ])("normalizes %s", (input, expected) => {
    expect(canonicalLifecycleEvent(input)).toBe(expected);
  });

  test("preserves unknown future events", () => {
    expect(canonicalLifecycleEvent("FutureEvent")).toBe("FutureEvent");
  });
});

describe("shouldUseAgentDeckApproval", () => {
  test("defers to Claude auto and bypass modes", () => {
    expect(shouldUseAgentDeckApproval("auto")).toBe(false);
    expect(shouldUseAgentDeckApproval("bypassPermissions")).toBe(false);
    expect(shouldUseAgentDeckApproval("dontAsk")).toBe(false);
  });

  test("does not intercept a destructive auto-mode tool call", () => {
    const command = { command: "rm -rf build" };
    expect(shouldRequestRemoteApproval("claude", "auto", "Bash", command, "destructive")).toBe(
      false,
    );
    expect(
      shouldRequestRemoteApproval("claude", "bypassPermissions", "Bash", command, "destructive"),
    ).toBe(false);
    expect(shouldRequestRemoteApproval("claude", "default", "Bash", command, "destructive")).toBe(
      true,
    );
  });

  test("keeps the remote gate in modes that may ask", () => {
    expect(shouldUseAgentDeckApproval("default")).toBe(true);
    expect(shouldUseAgentDeckApproval("acceptEdits")).toBe(true);
    expect(shouldUseAgentDeckApproval(undefined)).toBe(true);
  });
});
