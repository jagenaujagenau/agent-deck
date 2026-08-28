import { describe, expect, test } from "bun:test";
import {
  canonicalLifecycleEvent,
  notificationIsIdle,
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
    ["SubagentStop", "SubagentStop"],
    ["subagent_stop", "SubagentStop"],
    ["subagentStop", "SubagentStop"],
    // Gemini CLI's names for the same moments, per its own migrate mapping.
    ["BeforeAgent", "UserPromptSubmit"],
    ["BeforeTool", "PreToolUse"],
    ["AfterTool", "PostToolUse"],
    ["AfterAgent", "Stop"],
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

describe("notificationIsIdle", () => {
  // Both strings are taken verbatim from what this bridge has actually stored,
  // not from the shapes the hook documentation describes.
  test("an idle prompt is not a request for attention", () => {
    expect(notificationIsIdle("Claude is waiting for your input")).toBe(true);
  });

  test("a permission prompt still needs a person", () => {
    expect(notificationIsIdle("Claude needs your permission")).toBe(false);
    expect(notificationIsIdle("Claude needs your permission to use Bash")).toBe(false);
  });

  test("unfamiliar wording is treated as needing a person", () => {
    expect(notificationIsIdle("Something new happened")).toBe(false);
    expect(notificationIsIdle("")).toBe(false);
  });

  test("a tool named for idling does not read as an idle prompt", () => {
    // "idle" as a word means the prompt is empty; as part of a name it does not.
    expect(notificationIsIdle("Claude needs your permission to use idlectl")).toBe(false);
  });
});
