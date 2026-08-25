import {
  requiresApproval,
  type ApprovalMode,
} from "../../packages/agent-adapter/src/approval-policy";

const lifecycleNames = new Map([
  ["sessionstart", "SessionStart"],
  ["userpromptsubmit", "UserPromptSubmit"],
  ["pretooluse", "PreToolUse"],
  ["posttooluse", "PostToolUse"],
  ["posttoolusefailure", "PostToolUseFailure"],
  ["notification", "Notification"],
  ["subagentstop", "SubagentStop"],
  ["stopfailure", "StopFailure"],
  ["stop", "Stop"],
  ["sessionend", "SessionEnd"],
]);

export function shouldUseAgentDeckApproval(permissionMode?: string): boolean {
  const mode = permissionMode?.replace(/[^a-z]/gi, "").toLowerCase();
  return mode !== "auto" && mode !== "bypasspermissions" && mode !== "dontask";
}

export function shouldRequestRemoteApproval(
  runtime: "claude" | "codex",
  permissionMode: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  approvalMode: ApprovalMode,
): boolean {
  return (
    requiresApproval(toolName, toolInput, approvalMode) &&
    (runtime !== "claude" || shouldUseAgentDeckApproval(permissionMode))
  );
}

export function canonicalLifecycleEvent(value: string): string {
  const key = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return lifecycleNames.get(key) ?? value;
}

/**
 * Whether a Notification means "nothing is happening" rather than "answer me".
 *
 * Claude Code fires Notification for two opposite situations: it is blocked on
 * a person, or it has simply been sitting at an empty prompt for a minute.
 * Reading the second as attention is what left finished sessions showing
 * "needs you" on the deck indefinitely - nothing clears that state until
 * someone types at the session, so being left alone was what kept it stuck.
 * Over this bridge's whole history the idle message is 35 of the 38
 * notifications ever received, so it is the common case, not the corner.
 *
 * Wording that matches neither is treated as blocking: a notification wrongly
 * shown costs a glance, while one wrongly swallowed costs someone the prompt
 * they were waiting to answer.
 */
export function notificationIsIdle(message: string): boolean {
  return /waiting for (?:your |user )?input|\bidle\b/i.test(message);
}
