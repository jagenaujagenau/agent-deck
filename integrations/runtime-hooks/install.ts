#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const target = process.argv[2] ?? "all";
const hook = resolve(import.meta.dir, "index.ts");
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SessionEnd"];

function install(runtime: "claude" | "codex", path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, unknown[]>;
  for (const event of events) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const command = `${quote(process.execPath)} ${quote(hook)} ${runtime} ${event}`;
    const cleaned = entries.filter((entry) => !JSON.stringify(entry).includes("integrations/runtime-hooks/index.ts"));
    cleaned.push({
      ...(event === "PreToolUse" ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command, timeout: event === "PreToolUse" ? 620 : 10 }],
    });
    hooks[event] = cleaned;
  }
  settings.hooks = hooks;
  if (existsSync(path) && !existsSync(`${path}.bak-agent-deck`)) copyFileSync(path, `${path}.bak-agent-deck`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Installed Agent Deck ${runtime} hooks in ${path}`);
}

if (target === "all" || target === "claude") install("claude", join(homedir(), ".claude", "settings.json"));
if (target === "all" || target === "codex") install("codex", join(homedir(), ".codex", "hooks.json"));
