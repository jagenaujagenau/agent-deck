import { describe, expect, test } from "bun:test";
import { deckAgentId, stateFromStatus, SubagentSessions } from "./session";

describe("deckAgentId", () => {
  test("is stable and namespaced to the runtime", () => {
    const id = deckAgentId("ses_fcd220dd4ffe7AzXEf5iM5Gms3");
    expect(id).toStartWith("opencode-");
    expect(id).toBe(deckAgentId("ses_fcd220dd4ffe7AzXEf5iM5Gms3"));
  });

  test("distinct sessions never collide", () => {
    expect(deckAgentId("a")).not.toBe(deckAgentId("b"));
  });
});

describe("SubagentSessions", () => {
  test("learns a child from the event that creates it", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "child", parentID: "root" });
    expect(seen.has("child")).toBe(true);
  });

  test("a root session has no parent and is never treated as a child", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "root" });
    expect(seen.shouldDrop("root")).toBe(false);
  });

  test("drops every later event about a known child", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "child", parentID: "root" });
    // The later events carry only the session id — parentage arrived once.
    expect(seen.shouldDrop("child")).toBe(true);
    expect(seen.shouldDrop("root")).toBe(false);
  });

  test("an empty parentID is not parentage", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "root", parentID: "" });
    expect(seen.shouldDrop("root")).toBe(false);
  });

  test("an event with no session is not dropped by accident", () => {
    expect(new SubagentSessions().shouldDrop(undefined)).toBe(false);
  });
});

describe("stateFromStatus", () => {
  test("idle is idle", () => {
    expect(stateFromStatus("idle")).toBe("idle");
  });

  test("every busy wording maps to running", () => {
    for (const status of ["active", "busy", "pending", "running", "streaming", "working"]) {
      expect(stateFromStatus(status)).toBe("running");
    }
  });

  test("unrecognised wording claims nothing", () => {
    // Saying nothing leaves the last known state standing, which is likelier
    // to be true than a guess.
    expect(stateFromStatus("quiescent")).toBeUndefined();
    expect(stateFromStatus(undefined)).toBeUndefined();
    expect(stateFromStatus(42)).toBeUndefined();
  });
});
