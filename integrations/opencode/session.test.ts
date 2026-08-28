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
    expect(seen.isChild("child")).toBe(true);
  });

  test("a root session has no parent and is never treated as a child", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "root" });
    expect(seen.isChild("root")).toBe(false);
    expect(seen.rootOf("root")).toBe("root");
  });

  test("threads every later event about a known child onto the root", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "child", parentID: "root" });
    // The later events carry only the session id — parentage arrived once.
    expect(seen.rootOf("child")).toBe("root");
    expect(seen.rootOf("root")).toBe("root");
  });

  test("a nested subagent reports to the top-level session", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "child", parentID: "root" });
    seen.observe({ id: "grandchild", parentID: "child" });
    expect(seen.rootOf("grandchild")).toBe("root");
  });

  test("a malformed parent cycle terminates instead of hanging", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "a", parentID: "b" });
    seen.observe({ id: "b", parentID: "a" });
    expect(["a", "b"]).toContain(seen.rootOf("a"));
  });

  test("remembers the errand's wording as the subagent's name", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "child", parentID: "root", title: "Fix lint in apps/server" });
    expect(seen.nameOf("child")).toBe("Fix lint in apps/server");
  });

  test("a later untitled update keeps the name already learned", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "child", parentID: "root", title: "Fix lint" });
    seen.observe({ id: "child", parentID: "root" });
    expect(seen.nameOf("child")).toBe("Fix lint");
  });

  test("an empty parentID is not parentage", () => {
    const seen = new SubagentSessions();
    seen.observe({ id: "root", parentID: "" });
    expect(seen.isChild("root")).toBe(false);
  });

  test("an event with no session is not treated as a child by accident", () => {
    expect(new SubagentSessions().isChild(undefined)).toBe(false);
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
