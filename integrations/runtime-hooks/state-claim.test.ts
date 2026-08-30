import { describe, expect, test } from "bun:test";
import { approvalClaim, claimWindow } from "./state-claim";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

describe("claimWindow", () => {
  test("claims exactly the time the window has left", () => {
    expect(claimWindow(new Date(NOW + 90_000).toISOString(), NOW)).toEqual({ ttlMs: 90_000 });
  });

  test("an expired or unreadable window is nothing to claim", () => {
    expect(claimWindow(new Date(NOW - 1).toISOString(), NOW)).toBeUndefined();
    expect(claimWindow("not a date", NOW)).toBeUndefined();
    expect(claimWindow(undefined, NOW)).toBeUndefined();
  });
});

describe("approvalClaim", () => {
  const expiresAt = new Date(NOW + 600_000).toISOString();

  test("waiting on a live approval claims its window", () => {
    expect(approvalClaim({ state: "waiting", pendingApproval: { expiresAt } }, NOW)).toEqual({
      ttlMs: 600_000,
    });
  });

  test("waiting on something only the terminal can see is not claimed", () => {
    // A notification about the runtime's own UI is the observer's to
    // describe; a claim here would suppress the better report.
    expect(approvalClaim({ state: "waiting" }, NOW)).toBeUndefined();
  });

  test("a state that is not waiting never claims, whatever it still holds", () => {
    expect(
      approvalClaim({ state: "running", pendingApproval: { expiresAt } }, NOW),
    ).toBeUndefined();
  });
});
