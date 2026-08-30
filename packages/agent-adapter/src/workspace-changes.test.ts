import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, diffForPath, fingerprintWorkspace } from "./workspace-changes";

describe("changedPaths", () => {
  test("reports a path that appeared", () => {
    expect(changedPaths({}, { "a.ts": "?? :10:1" })).toEqual(["a.ts"]);
  });

  test("reports a dirty file edited again", () => {
    // The case `git status` alone cannot see: the status letter is unchanged,
    // only the contents moved.
    expect(changedPaths({ "a.ts": " M:10:1" }, { "a.ts": " M:20:2" })).toEqual(["a.ts"]);
  });

  test("says nothing when nothing moved", () => {
    const same = { "a.ts": " M:10:1", "b.ts": "??:3:4" };
    expect(changedPaths(same, { ...same })).toEqual([]);
  });

  test("a path that left the set is not an edit", () => {
    // Committing or reverting removes it from the dirty set without its
    // contents changing, and reporting that would be an edit that never was.
    expect(changedPaths({ "a.ts": " M:10:1" }, {})).toEqual([]);
  });

  test("one command cannot flood the deck", () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, "??:1:1"]),
    );
    expect(changedPaths({}, many)).toHaveLength(20);
  });
});

describe("fingerprinting a real repository", () => {
  /** A throwaway repository with one committed file, standing in for a session's workspace. */
  function repo() {
    const cwd = mkdtempSync(join(tmpdir(), "workspace-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(cwd, "tracked.ts"), "const before = 1;\n");
    git("add", ".");
    git("commit", "-qm", "seed");
    return cwd;
  }

  test("a shell edit shows up between two fingerprints, with a diff to publish", () => {
    const cwd = repo();
    const before = fingerprintWorkspace(cwd);
    expect(before).toEqual({});
    writeFileSync(join(cwd, "tracked.ts"), "const after = 2;\n");
    const now = fingerprintWorkspace(cwd);
    expect(changedPaths(before!, now!)).toEqual(["tracked.ts"]);
    const diff = diffForPath(cwd, "tracked.ts");
    expect(diff).toContain("-const before = 1;");
    expect(diff).toContain("+const after = 2;");
  });

  test("a file git has never seen still diffs as an addition", () => {
    const cwd = repo();
    const before = fingerprintWorkspace(cwd);
    writeFileSync(join(cwd, "fresh.ts"), "const fresh = 3;\n");
    const now = fingerprintWorkspace(cwd);
    expect(changedPaths(before!, now!)).toEqual(["fresh.ts"]);
    expect(diffForPath(cwd, "fresh.ts")).toContain("+const fresh = 3;");
  });
});
