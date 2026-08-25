import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "./unified-diff";

describe("unifiedDiff", () => {
  test("locates a mid-file edit at its real line numbers", () => {
    const before = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n");
    const after = ["one", "two", "three", "four", "CHANGED", "six", "seven", "eight"].join("\n");

    expect(unifiedDiff(before, after)).toBe(
      [
        "@@ -2,7 +2,7 @@",
        " two",
        " three",
        " four",
        "-five",
        "+CHANGED",
        " six",
        " seven",
        " eight",
      ].join("\n"),
    );
  });

  test("reports no change as an empty diff rather than a hunk", () => {
    expect(unifiedDiff("same\ntext\n", "same\ntext\n")).toBe("");
  });

  test("a brand new file is one hunk against an empty old side", () => {
    expect(unifiedDiff("", "alpha\nbeta\n")).toBe(
      ["@@ -0,0 +1,2 @@", "+alpha", "+beta"].join("\n"),
    );
  });

  test("a full rewrite of an existing file keeps the deletions visible", () => {
    const diff = unifiedDiff("old line\n", "new line\n");
    expect(diff).toBe(["@@ -1,1 +1,1 @@", "-old line", "+new line"].join("\n"));
  });

  test("distant changes become separate hunks, near ones merge", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before
      .split("\n")
      .map((line, i) => (i === 2 || i === 30 ? `${line} edited` : line))
      .join("\n");

    const hunks = unifiedDiff(before, after)!
      .split("\n")
      .filter((line) => line.startsWith("@@"));
    expect(hunks).toEqual(["@@ -1,6 +1,6 @@", "@@ -28,7 +28,7 @@"]);

    const near = before
      .split("\n")
      .map((line, i) => (i === 2 || i === 5 ? `${line} edited` : line))
      .join("\n");
    expect(
      unifiedDiff(before, near)!
        .split("\n")
        .filter((line) => line.startsWith("@@")),
    ).toEqual(["@@ -1,9 +1,9 @@"]);
  });

  test("a pure insertion anchors at the line it follows with a zero-length old range", () => {
    expect(unifiedDiff("a\nb\n", "a\ninserted\nb\n")).toBe(
      ["@@ -1,2 +1,3 @@", " a", "+inserted", " b"].join("\n"),
    );
  });

  test("a trailing newline does not invent an extra blank line", () => {
    expect(unifiedDiff("a\n", "a\nb\n")).toBe(["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"));
  });

  test("line counts in the header match the lines actually emitted", () => {
    const before = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    const after = before
      .split("\n")
      .filter((_, i) => i !== 100)
      .join("\n");

    const diff = unifiedDiff(before, after);
    if (diff === null) throw new Error("expected a diff for a single deleted line");
    const lines = diff.split("\n");
    const header = lines[0] ?? "";
    const counts = header.match(/@@ -\d+,(\d+) \+\d+,(\d+) @@/);
    if (counts === null) throw new Error(`expected a hunk header, got: ${header}`);
    const [, oldCount, newCount] = counts;
    expect(lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).length).toBe(
      Number(oldCount),
    );
    expect(lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).length).toBe(
      Number(newCount),
    );
  });

  test("bails out instead of burning the user's turn on a wholly dissimilar rewrite", () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");

    expect(unifiedDiff(before, after, { maxEdits: 50 })).toBeNull();
    expect(unifiedDiff("a", "b", { maxLines: 0 })).toBeNull();
  });
});
