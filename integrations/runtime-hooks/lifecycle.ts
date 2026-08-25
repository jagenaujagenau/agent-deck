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
