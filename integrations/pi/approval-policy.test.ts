import { describe, expect, test } from "bun:test";
import {
  describeToolCall,
  normalizeApprovalMode,
  requiresApproval,
  usesRemoteApproval,
} from "./approval-policy";

describe("Pi remote approval policy", () => {
  test.each([
    "rm -rf build",
    "sudo launchctl kickstart system/foo",
    "git push origin main",
    "git reset --hard HEAD~1",
    "terraform destroy",
    "kubectl delete namespace production",
    "npm publish",
  ])("gates destructive bash: %s", (command) => {
    expect(requiresApproval("bash", { command }, "destructive")).toBe(true);
  });

  test("does not interrupt ordinary inspection", () => {
    expect(requiresApproval("bash", { command: "rg TODO src && git status" }, "destructive")).toBe(
      false,
    );
    expect(requiresApproval("read", { path: "README.md" }, "all")).toBe(false);
  });

  test("gates credential writes in destructive mode", () => {
    expect(requiresApproval("write", { path: ".env.production" }, "destructive")).toBe(true);
    expect(requiresApproval("edit", { path: "config/auth.json" }, "destructive")).toBe(true);
    expect(requiresApproval("edit", { path: "src/main.ts" }, "destructive")).toBe(false);
  });

  test("all mode gates every mutating built-in tool", () => {
    expect(requiresApproval("edit", { path: "src/main.ts" }, "all")).toBe(true);
    expect(requiresApproval("write", { path: "notes.txt" }, "all")).toBe(true);
    expect(requiresApproval("bash", { command: "echo safe" }, "all")).toBe(true);
  });

  test("off mode never gates or advertises remote approvals", () => {
    expect(requiresApproval("bash", { command: "rm -rf /" }, "off")).toBe(false);
    expect(usesRemoteApproval("off")).toBe(false);
  });

  test("unknown configuration fails safely to destructive", () => {
    expect(normalizeApprovalMode("auto")).toBe("destructive");
    expect(normalizeApprovalMode("unexpected")).toBe("destructive");
  });

  test("preserves the exact command for remote inspection", () => {
    expect(describeToolCall("bash", { command: "git push origin main" })).toBe(
      "git push origin main",
    );
  });
});
