import { basename } from "node:path";

/** Resolve the stable repository/project identity, never the tool's transient cwd. */
export function projectNameForCwd(cwd: string): string {
  const result = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stderr: "ignore",
  });
  if (result.exitCode === 0) {
    const root = result.stdout.toString().trim();
    if (root) return basename(root);
  }
  return basename(cwd) || "unknown";
}
