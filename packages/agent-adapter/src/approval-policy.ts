export type ApprovalMode = "off" | "destructive" | "all";

export function normalizeApprovalMode(value: string | undefined): ApprovalMode {
  return value && ["off", "destructive", "all"].includes(value)
    ? (value as ApprovalMode)
    : "destructive";
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

export function requiresApproval(
  toolName: string,
  input: Record<string, unknown>,
  mode: ApprovalMode,
): boolean {
  if (!usesRemoteApproval(mode)) return false;
  const normalized = toolName.toLowerCase();
  if (mode === "all") return ["bash", "write", "edit"].includes(normalized);
  if (normalized === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return HIGH_RISK_BASH_PATTERNS.some((pattern) => pattern.test(command));
  }
  if (normalized === "write" || normalized === "edit") {
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : "";
    return SENSITIVE_PATH_PATTERN.test(path);
  }
  return false;
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" && typeof input.command === "string") return input.command;
  if (normalized === "write" || normalized === "edit") {
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
    if (path) return `${toolName} ${path}`;
  }
  try {
    return `${toolName} ${JSON.stringify(input)}`;
  } catch {
    return toolName;
  }
}
