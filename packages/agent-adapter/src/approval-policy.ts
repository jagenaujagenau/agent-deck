import { asString } from "./json-value";
import type { JsonObject } from "./json-value";

export type ApprovalMode = "off" | "destructive" | "all";

export function normalizeApprovalMode(value: string | undefined): ApprovalMode {
  return value === "off" || value === "destructive" || value === "all" ? value : "destructive";
}

export function usesRemoteApproval(mode: ApprovalMode): boolean {
  return mode === "destructive" || mode === "all";
}

const HIGH_RISK_BASH_PATTERNS = [
  /(^|[;&|]\s*)sudo\b/i,
  /\brm\s+(?:-[^\s]*[rf][^\s]*\s+|--recursive\b|--force\b)/i,
  /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(?:kill|pkill|killall)\b/i,
  /\b(?:chmod|chown)\s+(?:-[rR]\s+)?(?:777|-[^\s]*R)/i,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/i,
  /\b(?:kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy))\b/i,
  /\b(?:deploy|release)\b/i,
  /(?:^|\s)(?:>|>>|tee\s+)\s*\/(?:etc|usr|System)\//i,
];

const SENSITIVE_PATH_PATTERN =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials?|secrets?|auth\.json|.*\.pem|.*\.key)$/i;

/**
 * One risk class across every runtime's tool vocabulary: Claude says Bash,
 * Write, Edit; Gemini says run_shell_command, write_file, replace. The policy
 * cares what a call does, not what its runtime named it.
 */
type ToolClass = "shell" | "write" | "edit" | "other";

function toolClass(toolName: string): ToolClass {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized === "shell" || normalized === "run_shell_command") {
    return "shell";
  }
  if (normalized === "write" || normalized === "write_file") return "write";
  if (normalized === "edit" || normalized === "replace" || normalized === "multiedit") {
    return "edit";
  }
  return "other";
}

export function requiresApproval(
  toolName: string,
  input: Readonly<JsonObject>,
  mode: ApprovalMode,
): boolean {
  if (!usesRemoteApproval(mode)) return false;
  const kind = toolClass(toolName);
  if (mode === "all") return kind !== "other";
  if (kind === "shell") {
    const command = asString(input.command) ?? "";
    return HIGH_RISK_BASH_PATTERNS.some((pattern) => pattern.test(command));
  }
  if (kind === "write" || kind === "edit") {
    const path = asString(input.path) ?? asString(input.file_path) ?? "";
    return SENSITIVE_PATH_PATTERN.test(path);
  }
  return false;
}

export function describeToolCall(toolName: string, input: Readonly<JsonObject>): string {
  const kind = toolClass(toolName);
  const command = asString(input.command);
  if (kind === "shell" && command !== undefined) return command;
  if (kind === "write" || kind === "edit") {
    const path = asString(input.path) ?? asString(input.file_path);
    if (path) return `${toolName} ${path}`;
  }
  try {
    return `${toolName} ${JSON.stringify(input)}`;
  } catch {
    return toolName;
  }
}
