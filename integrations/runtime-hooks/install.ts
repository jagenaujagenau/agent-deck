#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isJsonObject, parseJson } from "./json-value";
import type { JsonObject } from "./json-value";

const target = process.argv[2] ?? "all";
const hook = resolve(import.meta.dir, "index.ts");
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const claudeEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd",
];
/**
 * Gemini CLI's names for the same lifecycle — its own `hooks migrate` command
 * documents the correspondence. The handler folds them back to the canonical
 * names, so one hook serves all three runtimes.
 */
const geminiEvents = [
  "SessionStart",
  "BeforeAgent",
  "BeforeTool",
  "AfterTool",
  "AfterAgent",
  "Notification",
  "SessionEnd",
];

/** One entry in a runtime's hook registry, in the shape the runtime reads back. */
type HookRegistration = {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout: number }>;
};

function install(runtime: "claude" | "codex" | "gemini", path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const stored = existsSync(path) ? parseJson(readFileSync(path, "utf8")) : {};
  const settings: JsonObject = isJsonObject(stored) ? stored : {};
  const hooks: JsonObject = isJsonObject(settings.hooks) ? settings.hooks : {};
  const events = runtime === "gemini" ? geminiEvents : claudeEvents;
  for (const event of events) {
    const existing = hooks[event];
    const command = `${quote(process.execPath)} ${quote(hook)} ${runtime} ${event}`;
    const cleaned = (Array.isArray(existing) ? existing : []).filter(
      (entry) => !JSON.stringify(entry).includes("integrations/runtime-hooks/index.ts"),
    );
    // Two literals rather than a conditional spread, so the matcher stays ahead
    // of the hooks in the file exactly as previous installs wrote it.
    const registration: HookRegistration =
      event === "PreToolUse" || event === "BeforeTool"
        ? { matcher: "*", hooks: [{ type: "command", command, timeout: 620 }] }
        : { hooks: [{ type: "command", command, timeout: 10 }] };
    cleaned.push(registration);
    hooks[event] = cleaned;
  }
  settings.hooks = hooks;
  if (existsSync(path) && !existsSync(`${path}.bak-agent-deck`))
    copyFileSync(path, `${path}.bak-agent-deck`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Installed Agent Deck ${runtime} hooks in ${path}`);
}

if (target === "all" || target === "claude")
  install("claude", join(homedir(), ".claude", "settings.json"));
if (target === "all" || target === "codex")
  install("codex", join(homedir(), ".codex", "hooks.json"));
if (target === "all" || target === "gemini")
  install("gemini", join(homedir(), ".gemini", "settings.json"));
