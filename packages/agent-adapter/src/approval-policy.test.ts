import { describe, expect, test } from "bun:test";
import { describeToolCall, requiresApproval } from "./approval-policy";

describe("requiresApproval", () => {
  test("a high-risk shell command needs a person, whatever its runtime calls the tool", () => {
    expect(requiresApproval("Bash", { command: "sudo rm -rf /" }, "destructive")).toBe(true);
    expect(requiresApproval("run_shell_command", { command: "sudo rm -rf /" }, "destructive")).toBe(
      true,
    );
    expect(requiresApproval("run_shell_command", { command: "ls -la" }, "destructive")).toBe(false);
  });

  test("a sensitive path guards edits under both vocabularies", () => {
    expect(requiresApproval("Edit", { file_path: "/app/.env" }, "destructive")).toBe(true);
    expect(requiresApproval("replace", { file_path: "/app/.env" }, "destructive")).toBe(true);
    expect(requiresApproval("write_file", { file_path: "/app/secrets" }, "destructive")).toBe(true);
    expect(requiresApproval("replace", { file_path: "/app/readme.md" }, "destructive")).toBe(false);
  });

  test("mode 'all' covers every mutating class, not a name list", () => {
    expect(requiresApproval("run_shell_command", { command: "ls" }, "all")).toBe(true);
    expect(requiresApproval("write_file", { file_path: "a.txt" }, "all")).toBe(true);
    expect(requiresApproval("read_file", { file_path: "a.txt" }, "all")).toBe(false);
  });
});

describe("describeToolCall", () => {
  test("a shell call is described by its command under any name", () => {
    expect(describeToolCall("run_shell_command", { command: "bun test" })).toBe("bun test");
  });

  test("a file call is described by its target", () => {
    expect(describeToolCall("replace", { file_path: "/src/a.ts" })).toBe("replace /src/a.ts");
  });
});
