import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Files past this size are left undiffed; the snapshot is not worth the turn latency or the disk. */
const MAX_SNAPSHOT_BYTES = 2_000_000;
/** Snapshots outlive their turn when a tool is denied mid-flight, so sweep anything clearly abandoned. */
const SNAPSHOT_TTL_MS = 60 * 60_000;

// Matched against the tool name with spaces, underscores and dashes stripped, so `apply_patch`,
// `applyPatch` and `apply-patch` all land on the same rule.
const FILE_TOOLS = /^(edit|write|create|update|multiedit|notebookedit|applypatch|strreplace)/i;

/** Whether this tool call is expected to change a file on disk, and so is worth snapshotting. */
export function mutatesFile(tool: string, target: string | undefined): target is string {
  return target !== undefined && target.length > 0 && FILE_TOOLS.test(tool.replace(/[\s_-]/g, ""));
}

function snapshotFile(directory: string, key: string) {
  return join(directory, `${createHash("sha1").update(key).digest("hex").slice(0, 32)}.snapshot`);
}

/**
 * Records a file's contents before a tool rewrites it. An absent target is stored as empty, so a
 * genuinely new file still diffs cleanly as an addition against nothing.
 */
export function captureSnapshot(directory: string, key: string, target: string): void {
  try {
    mkdirSync(directory, { recursive: true });
    let content = "";
    if (existsSync(target)) {
      if (statSync(target).size > MAX_SNAPSHOT_BYTES) return;
      content = readFileSync(target, "utf8");
    }
    writeFileSync(snapshotFile(directory, key), content);
  } catch {
    /* Snapshotting is best effort; the caller falls back to a coarse diff. */
  }
}

/** Reads and removes a snapshot. Returns null when none was taken for this key. */
export function consumeSnapshot(directory: string, key: string): string | null {
  const path = snapshotFile(directory, key);
  try {
    const content = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    return content;
  } catch {
    return null;
  }
}

export function readFileForDiff(target: string): string | null {
  try {
    if (!existsSync(target) || statSync(target).size > MAX_SNAPSHOT_BYTES) return null;
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

export function pruneSnapshots(directory: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".snapshot")) continue;
      const path = join(directory, name);
      if (now - statSync(path).mtimeMs > SNAPSHOT_TTL_MS) rmSync(path, { force: true });
    }
  } catch {
    /* Nothing to prune. */
  }
}
