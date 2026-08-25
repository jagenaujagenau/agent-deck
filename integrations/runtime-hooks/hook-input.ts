/**
 * The payload Claude Code writes to a hook's stdin, parsed once.
 *
 * This is another program's JSON and its shape varies by event and by version,
 * so it is read here and nowhere else: every field the hooks use is narrowed
 * once, and the rest of the process works with a named type instead of probing
 * an untyped bag key by key.
 *
 * Deliberately hand-written rather than schema-driven. A hook runs on every
 * tool call, and its dependency graph already costs 120-290ms to load;
 * measured against that, pulling in a schema library doubled it. The trade is
 * wrong for a process on that path.
 */

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A tool's arguments. Every tool has its own, so only shared keys are named. */
export interface ToolArguments {
  file_path?: string;
  path?: string;
  command?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  /** AskUserQuestion's questions, the one tool payload the hooks interpret. */
  questions?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Kept so a caller can read a key this does not name yet. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface HookPayload {
  sessionId?: string;
  cwd?: string;
  eventName?: string;
  toolName?: string;
  toolUseId?: string;
  toolArguments: ToolArguments;
  prompt?: string;
  lastAssistantMessage?: string;
  notificationType?: string;
  message?: string;
  transcriptPath?: string;
  permissionMode?: string;
}

const EMPTY_ARGUMENTS: ToolArguments = { raw: Object.freeze({}) };

function toolArguments(value: unknown): ToolArguments {
  if (!value || typeof value !== "object") return EMPTY_ARGUMENTS;
  const raw = value as Record<string, unknown>;
  return {
    file_path: asString(raw.file_path),
    path: asString(raw.path),
    command: asString(raw.command),
    old_string: asString(raw.old_string),
    new_string: asString(raw.new_string),
    content: asString(raw.content),
    questions: Array.isArray(raw.questions)
      ? raw.questions.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
        )
      : undefined,
    raw,
  };
}

/** Parses a hook payload. Anything unreadable yields an empty one, never a throw. */
export function parseHookPayload(text: string): HookPayload {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    value = {};
  }
  if (!value || typeof value !== "object") return { toolArguments: EMPTY_ARGUMENTS };
  const raw = value as Record<string, unknown>;
  return {
    sessionId: asString(raw.session_id),
    cwd: asString(raw.cwd),
    eventName: asString(raw.hook_event_name),
    toolName: asString(raw.tool_name),
    toolUseId: asString(raw.tool_use_id),
    toolArguments: toolArguments(raw.tool_input),
    prompt: asString(raw.prompt),
    lastAssistantMessage: asString(raw.last_assistant_message),
    notificationType: asString(raw.notification_type),
    message: asString(raw.message),
    transcriptPath: asString(raw.transcript_path),
    permissionMode: asString(raw.permission_mode),
  };
}
