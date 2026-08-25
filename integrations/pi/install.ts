#!/usr/bin/env bun
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function ensureLink(target: string, link: string) {
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error(`${link} exists and is not a symbolic link`);
    const current = resolve(join(link, ".."), readlinkSync(link));
    if (current !== target) throw new Error(`${link} points to ${current}; expected ${target}`);
    return;
  } catch (error) {
    if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error;
  }
  symlinkSync(target, link, "dir");
}

const extensionTarget = resolve(import.meta.dir);
const sdkTarget = resolve(import.meta.dir, "../../packages/agent-adapter");
const piRoot = join(homedir(), ".pi", "agent");
const extensions = join(piRoot, "extensions");
const packages = join(piRoot, "packages");
mkdirSync(extensions, { recursive: true });
mkdirSync(packages, { recursive: true });
ensureLink(extensionTarget, join(extensions, "agent-deck"));
ensureLink(sdkTarget, join(packages, "agent-adapter"));
console.log(
  "Installed Agent Deck Pi extension and runtime SDK. Run /reload in active Pi sessions.",
);
