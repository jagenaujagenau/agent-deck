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

import { asString, isJsonObject, parseJson } from "./json-value";
import type { JsonObject, JsonValue } from "./json-value";

/** One AskUserQuestion entry, narrowed to what the hooks put in front of a person. */
export interface ToolQuestion {
  /** What to ask, from `question` falling back to `header`. */
  prompt?: string;
  /** The choices' labels, already flattened from the tool's option objects. */
  options: string[];
}

/** A tool's arguments. Every tool has its own, so only shared keys are named. */
export interface ToolArguments {
  file_path?: string;
  path?: string;
  command?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  /** AskUserQuestion's questions, the one tool payload the hooks interpret. */
  questions?: ToolQuestion[];
  /** Kept so a caller can hand the whole payload to something that describes it. */
  readonly raw: Readonly<JsonObject>;
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
  /**
   * The subagent a SubagentStop refers to. Its own id and kind, alongside - not
   * instead of - the parent's `sessionId`, which is what makes subagent work
   * reportable without inventing a second session for it.
   */
  agentId?: string;
  agentType?: string;
}

const EMPTY_ARGUMENTS: ToolArguments = { raw: Object.freeze({}) };

function toolQuestion(entry: JsonObject): ToolQuestion {
  const question: ToolQuestion = { options: [] };
  const prompt = entry.question ?? entry.header;
  if (prompt !== undefined) question.prompt = String(prompt);
  if (Array.isArray(entry.options)) {
    question.options = entry.options
      .map((option) =>
        isJsonObject(option)
          ? String(option.label ?? "")
          : Array.isArray(option)
            ? ""
            : String(option),
      )
      .filter(Boolean);
  }
  return question;
}

function toolQuestions(value: JsonValue | undefined): ToolQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isJsonObject).map(toolQuestion);
}

function toolArguments(value: JsonValue | undefined): ToolArguments {
  if (!isJsonObject(value)) return EMPTY_ARGUMENTS;
  return {
    file_path: asString(value.file_path),
    path: asString(value.path),
    command: asString(value.command),
    old_string: asString(value.old_string),
    new_string: asString(value.new_string),
    content: asString(value.content),
    questions: toolQuestions(value.questions),
    raw: value,
  };
}

/** Parses a hook payload. Anything unreadable yields an empty one, never a throw. */
export function parseHookPayload(text: string): HookPayload {
  let value: JsonValue;
  try {
    value = text.trim() ? parseJson(text) : {};
  } catch {
    value = {};
  }
  if (!isJsonObject(value)) return { toolArguments: EMPTY_ARGUMENTS };
  return {
    sessionId: asString(value.session_id),
    cwd: asString(value.cwd),
    eventName: asString(value.hook_event_name),
    toolName: asString(value.tool_name),
    toolUseId: asString(value.tool_use_id),
    toolArguments: toolArguments(value.tool_input),
    prompt: asString(value.prompt),
    // Gemini's AfterAgent calls the same fact `prompt_response`.
    lastAssistantMessage: asString(value.last_assistant_message) ?? asString(value.prompt_response),
    notificationType: asString(value.notification_type),
    message: asString(value.message),
    transcriptPath: asString(value.transcript_path),
    permissionMode: asString(value.permission_mode),
    agentId: asString(value.agent_id),
    agentType: asString(value.agent_type),
  };
}
