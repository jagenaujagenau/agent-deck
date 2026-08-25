import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * File changes made by a shell command.
 *
 * The existing capture works by snapshotting a file before a tool rewrites it,
 * which needs the path in advance. A shell command does not offer one: a
 * heredoc, a `sed -i`, a script that writes ten files all arrive as opaque
 * text, and every edit made that way was invisible to the Changes tab.
 *
 * So this asks the workspace instead. One `git status` per shell command,
 * compared against what it looked like after the last one, gives the set of
 * paths that moved - which is cheap, needs no cooperation from the command,
 * and is bounded by how much is dirty rather than by repository size.
 */

/** Path to a stamp of its state, so a second edit to a dirty file still registers. */
export type WorkspaceFingerprint = Record<string, string>;

/** Beyond this a working tree is not a set of edits, it is a build directory. */
const MAX_TRACKED_PATHS = 200;
/** What one shell command may report, so a `find -delete` cannot flood the deck. */
const MAX_CHANGES_PER_COMMAND = 20;
const MAX_DIFF_BYTES = 16_000;

/**
 * Runs git and returns its output.
 *
 * `diff` reports whether anything differed through its exit code, and
 * `--no-index` uses 1 to mean "these files differ" - which is the answer being
 * asked for, not a failure. So a diff's output counts at 0 or 1, and anything
 * else is a real error.
 */
function git(cwd: string, args: string[], okStatuses: number[] = [0]): string | undefined {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 4_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || run.status === null || !okStatuses.includes(run.status)) return undefined;
  return run.stdout;
}

/**
 * A stamp of everything currently uncommitted.
 *
 * `git status` says which paths are dirty but not whether a dirty file changed
 * again, so size and mtime come from the filesystem: without them, editing an
 * already-modified file twice would look like nothing happened.
 */
export function fingerprintWorkspace(cwd: string): WorkspaceFingerprint | undefined {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === undefined) return undefined;
  const fingerprint: WorkspaceFingerprint = {};
  let seen = 0;
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    if (++seen > MAX_TRACKED_PATHS) break;
    const code = line.slice(0, 2);
    // A rename reads as `R  old -> new`; the new name is the one that exists.
    const raw = line.slice(3);
    const path = raw.includes(" -> ") ? raw.slice(raw.indexOf(" -> ") + 4) : raw;
    const clean = path.replace(/^"|"$/g, "");
    let stamp = "gone";
    try {
      const info = statSync(join(cwd, clean));
      stamp = `${info.size}:${info.mtimeMs}`;
    } catch {
      // Deleted, or a path git reports that no longer exists.
    }
    fingerprint[clean] = `${code}:${stamp}`;
  }
  return fingerprint;
}

/** Paths whose state differs from the previous stamp. */
export function changedPaths(
  previous: WorkspaceFingerprint,
  current: WorkspaceFingerprint,
): string[] {
  const changed: string[] = [];
  for (const [path, stamp] of Object.entries(current)) {
    if (previous[path] !== stamp) changed.push(path);
  }
  // A path that left the set was committed or reverted, not edited: its content
  // did not change, so reporting it would be an edit that never happened.
  return changed.sort().slice(0, MAX_CHANGES_PER_COMMAND);
}

/**
 * A unified diff for one path, however git can express it.
 *
 * A file git has never seen has nothing to diff against, so `--no-index`
 * against /dev/null renders it as the addition it is.
 */
export function diffForPath(cwd: string, path: string): string | undefined {
  const tracked = git(cwd, ["diff", "HEAD", "--", path], [0, 1]);
  if (tracked && tracked.trim()) return tracked.slice(0, MAX_DIFF_BYTES);
  const untracked = git(cwd, ["diff", "--no-index", "--", "/dev/null", path], [0, 1]);
  if (untracked && untracked.trim()) return untracked.slice(0, MAX_DIFF_BYTES);
  return undefined;
}
