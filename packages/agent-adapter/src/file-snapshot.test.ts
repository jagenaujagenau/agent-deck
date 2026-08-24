import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSnapshot, consumeSnapshot, mutatesFile, pruneSnapshots, readFileForDiff } from "./file-snapshot";

function scratch() {
  return mkdtempSync(join(tmpdir(), "agent-deck-snapshot-"));
}

describe("mutatesFile", () => {
  test("recognises the file-writing tools across runtime naming styles", () => {
    expect(mutatesFile("Edit", "/tmp/a.ts")).toBe(true);
    expect(mutatesFile("Write", "/tmp/a.ts")).toBe(true);
    expect(mutatesFile("MultiEdit", "/tmp/a.ts")).toBe(true);
    expect(mutatesFile("apply_patch", "/tmp/a.ts")).toBe(true);
    expect(mutatesFile("str_replace_editor", "/tmp/a.ts")).toBe(true);
  });

  test("ignores tools that do not write files, and calls with no target", () => {
    expect(mutatesFile("Bash", "/tmp/a.ts")).toBe(false);
    expect(mutatesFile("Read", "/tmp/a.ts")).toBe(false);
    expect(mutatesFile("Edit", undefined)).toBe(false);
    expect(mutatesFile("Edit", "")).toBe(false);
  });
});

describe("snapshots", () => {
  test("round-trips a file's prior contents and clears itself after one read", () => {
    const directory = scratch();
    const target = join(directory, "source.ts");
    writeFileSync(target, "before\n");

    captureSnapshot(directory, "call-1", target);
    expect(consumeSnapshot(directory, "call-1")).toBe("before\n");
    // A second read must not resurrect it, or a later turn would diff against stale content.
    expect(consumeSnapshot(directory, "call-1")).toBeNull();
  });

  test("a file that does not exist yet snapshots as empty, not as missing", () => {
    const directory = scratch();

    captureSnapshot(directory, "call-2", join(directory, "brand-new.ts"));
    expect(consumeSnapshot(directory, "call-2")).toBe("");
  });

  test("keys are independent, so concurrent tool calls do not read each other's snapshots", () => {
    const directory = scratch();
    const first = join(directory, "one.ts");
    const second = join(directory, "two.ts");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");

    captureSnapshot(directory, "call-a", first);
    captureSnapshot(directory, "call-b", second);
    expect(consumeSnapshot(directory, "call-a")).toBe("one\n");
    expect(consumeSnapshot(directory, "call-b")).toBe("two\n");
  });

  test("oversized files are skipped rather than snapshotted", () => {
    const directory = scratch();
    const target = join(directory, "huge.bin");
    writeFileSync(target, "x".repeat(2_000_001));

    captureSnapshot(directory, "call-3", target);
    expect(consumeSnapshot(directory, "call-3")).toBeNull();
    expect(readFileForDiff(target)).toBeNull();
  });

  test("abandoned snapshots are swept once they age out", () => {
    const directory = scratch();
    writeFileSync(join(directory, "fresh.ts"), "x");
    captureSnapshot(directory, "recent", join(directory, "fresh.ts"));
    captureSnapshot(directory, "stale", join(directory, "fresh.ts"));

    const stalePath = readdirSync(directory).map((n) => join(directory, n)).find((p) => p.endsWith(".snapshot"))!;
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(stalePath, old, old);

    pruneSnapshots(directory);
    expect(readdirSync(directory).filter((n) => n.endsWith(".snapshot")).length).toBe(1);
  });

  test("a missing snapshot directory is not an error for any operation", () => {
    const directory = join(scratch(), "never-created");
    expect(consumeSnapshot(directory, "nope")).toBeNull();
    expect(() => pruneSnapshots(directory)).not.toThrow();
  });

  test("readFileForDiff returns the current contents on disk", () => {
    const directory = scratch();
    const target = join(directory, "after.ts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(target, "after\n");

    expect(readFileForDiff(target)).toBe("after\n");
    expect(readFileForDiff(join(directory, "absent.ts"))).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("after\n");
  });
});
