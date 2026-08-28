import { describe, expect, test } from "bun:test";
import { coarseDiff, fileTarget, shellCommand } from "./toolcall";

describe("shellCommand", () => {
  test("reads the command line off a shell tool", () => {
    expect(shellCommand("bash", { command: "bun test --cwd integrations" })).toBe(
      "bun test --cwd integrations",
    );
  });

  test("a non-shell tool has no command even when the argument exists", () => {
    expect(shellCommand("edit", { command: "rm -rf /" })).toBeUndefined();
  });

  test("a blank command is no command", () => {
    expect(shellCommand("bash", { command: "   " })).toBeUndefined();
    expect(shellCommand("bash", {})).toBeUndefined();
    expect(shellCommand("bash", undefined)).toBeUndefined();
  });
});

describe("fileTarget", () => {
  test("reads OpenCode's camelCase spelling", () => {
    expect(fileTarget({ filePath: "/repo/a.ts" })).toBe("/repo/a.ts");
  });

  test("accepts the snake_case and bare spellings too", () => {
    expect(fileTarget({ file_path: "/repo/b.ts" })).toBe("/repo/b.ts");
    expect(fileTarget({ path: "/repo/c.ts" })).toBe("/repo/c.ts");
  });

  test("a call without a file names no target", () => {
    expect(fileTarget({ command: "ls" })).toBeUndefined();
    expect(fileTarget(undefined)).toBeUndefined();
  });
});

describe("coarseDiff", () => {
  test("renders an edit's old and new strings as removal and addition", () => {
    expect(coarseDiff("edit", { oldString: "a\nb", newString: "c" })).toBe("- a\n- b\n+ c");
  });

  test("renders a write's content as pure addition", () => {
    expect(coarseDiff("write", { content: "x\ny" })).toBe("+ x\n+ y");
  });

  test("content on a non-writing tool is not a diff", () => {
    expect(coarseDiff("read", { content: "x" })).toBeUndefined();
  });

  test("a call with neither shape has no diff", () => {
    expect(coarseDiff("bash", { command: "ls" })).toBeUndefined();
  });
});
