import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { projectNameForCwd } from "./project";

describe("projectNameForCwd", () => {
  test("keeps nested tool working directories attached to the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentdeck-project-"));
    const nested = join(root, "src", "ui", "input");
    await mkdir(nested, { recursive: true });
    Bun.spawnSync(["git", "-C", root, "init", "-q"]);
    expect(projectNameForCwd(root)).toBe(basename(root));
    expect(projectNameForCwd(nested)).toBe(basename(root));
  });

  test("falls back to the directory outside a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentdeck-standalone-"));
    expect(projectNameForCwd(directory)).toBe(basename(directory));
  });
});
