import { asString, type JsonObject } from "./payload";

/**
 * The deck-relevant facts inside a tool call's arguments.
 *
 * OpenCode spells its arguments in camelCase where Claude's runtime uses
 * snake_case; both spellings are read so a provider-shaped tool that slips
 * through still reports its target.
 */

const SHELL_TOOLS = /^(bash|shell|run|terminal)/i;

/** The command line a shell tool is about to run, when this call is one. */
export function shellCommand(tool: string, args: JsonObject | undefined): string | undefined {
  if (!SHELL_TOOLS.test(tool)) return undefined;
  const command = asString(args?.command);
  return command?.trim() ? command : undefined;
}

/** The file a tool call is aimed at, under whichever spelling the tool uses. */
export function fileTarget(args: JsonObject | undefined): string | undefined {
  const target = asString(args?.filePath) ?? asString(args?.file_path) ?? asString(args?.path);
  return target?.trim() ? target : undefined;
}

/**
 * A coarse change description straight from the arguments, for when no real
 * before/after diff is possible. Carries no line numbers, which is exactly why
 * it is only the fallback.
 */
export function coarseDiff(tool: string, args: JsonObject | undefined): string | undefined {
  const oldText = asString(args?.oldString) ?? asString(args?.old_string);
  const newText = asString(args?.newString) ?? asString(args?.new_string);
  if (oldText !== undefined && newText !== undefined) {
    return `- ${oldText.replace(/\n/g, "\n- ")}\n+ ${newText.replace(/\n/g, "\n+ ")}`;
  }
  const content = asString(args?.content);
  if (/write|create/i.test(tool) && content !== undefined) {
    return `+ ${content.replace(/\n/g, "\n+ ")}`;
  }
  return undefined;
}
