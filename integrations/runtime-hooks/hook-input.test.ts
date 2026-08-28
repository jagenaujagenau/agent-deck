import { describe, expect, test } from "bun:test";
import { parseHookPayload } from "./hook-input";

describe("SubagentStop", () => {
  /**
   * Captured verbatim from Claude Code by registering a capture-only hook and
   * running one Task, rather than written from what the fields were assumed to
   * be. The two id fields are the point: `session_id` is the parent's, so a
   * subagent is reportable without deriving a second session for it.
   */
  const captured = {
    hook_event_name: "SubagentStop",
    session_id: "524b71cd-e679-48b3-a9e1-3dd01b81bd1c",
    transcript_path: "/Users/d/.claude/projects/x/524b71cd-e679-48b3-a9e1-3dd01b81bd1c.jsonl",
    agent_id: "ac8d00c8c4874f01b",
    agent_type: "general-purpose",
    agent_transcript_path: "/Users/d/.claude/projects/x/agent-ac8d00c8c4874f01b.jsonl",
    cwd: "/tmp/probe",
    permission_mode: "default",
    last_assistant_message: "File: ./sample.txt contains hello",
    stop_hook_active: false,
  };

  test("reads the subagent's own identity", () => {
    const input = parseHookPayload(JSON.stringify(captured));
    expect(input.agentId).toBe("ac8d00c8c4874f01b");
    expect(input.agentType).toBe("general-purpose");
  });

  test("keeps the parent's session, which is what the deck files it under", () => {
    const input = parseHookPayload(JSON.stringify(captured));
    expect(input.sessionId).toBe("524b71cd-e679-48b3-a9e1-3dd01b81bd1c");
  });

  test("carries the subagent's result", () => {
    const input = parseHookPayload(JSON.stringify(captured));
    expect(input.lastAssistantMessage).toBe("File: ./sample.txt contains hello");
  });

  test("an event without subagent fields leaves them absent", () => {
    const input = parseHookPayload(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    expect(input.agentId).toBeUndefined();
    expect(input.agentType).toBeUndefined();
  });
});

describe("Gemini payloads", () => {
  test("AfterAgent's prompt_response is the last assistant message by another name", () => {
    const payload = parseHookPayload(
      JSON.stringify({
        hook_event_name: "AfterAgent",
        session_id: "g-1",
        prompt: "fix the test",
        prompt_response: "Done - the test passes now.",
      }),
    );
    expect(payload.lastAssistantMessage).toBe("Done - the test passes now.");
  });

  test("Claude's own field still wins where both exist", () => {
    const payload = parseHookPayload(
      JSON.stringify({ last_assistant_message: "claude words", prompt_response: "gemini words" }),
    );
    expect(payload.lastAssistantMessage).toBe("claude words");
  });

  test("Gemini tool payloads parse through the same fields", () => {
    const payload = parseHookPayload(
      JSON.stringify({
        hook_event_name: "BeforeTool",
        tool_name: "run_shell_command",
        tool_input: { command: "bun test" },
      }),
    );
    expect(payload.toolName).toBe("run_shell_command");
    expect(payload.toolArguments.command).toBe("bun test");
  });
});
