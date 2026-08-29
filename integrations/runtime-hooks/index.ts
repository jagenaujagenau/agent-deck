#!/usr/bin/env bun
/**
 * The hook entry Claude Code, Codex, and Gemini spawn per lifecycle event.
 *
 * This process used to do all the work itself, and paying bun startup plus
 * the full module graph cost 120-290ms on every tool call. Now it is a shim:
 * derive which session this event belongs to, offer it to that session's
 * daemon over the unix socket, and print whatever comes back. Only when no
 * daemon answers — SessionStart before one exists, a daemon that died, an
 * error reply — is the full handler loaded, via dynamic import so the fast
 * path never pays for it.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { callHookSocket } from "./hook-socket";
import { asString, isJsonObject, parseJson } from "./json-value";
import type { JsonValue } from "./json-value";

const runtime =
  process.argv[2] === "codex" ? "codex" : process.argv[2] === "gemini" ? "gemini" : "claude";
const expectedEvent = process.argv[3] ?? "";
const inputText = await Bun.stdin.text();

// A targeted peek at the payload: only the fields that name the session and
// therefore the socket. The handler re-derives the same identity from the
// same payload, so the two stay in agreement by construction.
let payload: JsonValue = null;
try {
  payload = parseJson(inputText);
} catch {
  /* The handler treats an unreadable payload as empty too. */
}
const field = (key: string) => (isJsonObject(payload) ? asString(payload[key]) : undefined);
const cwd = field("cwd") ?? process.cwd();
const sessionSeed = field("session_id") ?? `${cwd}:${field("transcript_path") ?? process.ppid}`;
const sessionKey = createHash("sha256").update(sessionSeed).digest("hex").slice(0, 24);
const statePath = join(
  homedir(),
  ".cache",
  "agent-deck",
  "runtime-hooks",
  `${runtime}-${sessionKey}.json`,
);

const reply = await callHookSocket(`${statePath}.sock`, {
  runtime,
  expectedEvent,
  payload: inputText,
  cwd: process.cwd(),
  ppid: process.ppid,
});
if (reply !== undefined && reply.error === undefined) {
  if (reply.stdout) console.log(reply.stdout);
  process.exit(reply.exitCode ?? 0);
}

const { handleHookEvent } = await import("./hook-handler");
const result = await handleHookEvent({
  runtime,
  expectedEvent,
  payloadText: inputText,
  hookCwd: process.cwd(),
  hookPpid: process.ppid,
});
if (result.stdout) console.log(result.stdout);
