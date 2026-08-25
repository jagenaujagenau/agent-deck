import { describe, expect, test } from "bun:test";
import { changedPaths } from "./workspace-changes";

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
