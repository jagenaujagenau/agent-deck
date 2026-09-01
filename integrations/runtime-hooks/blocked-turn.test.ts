import { describe, expect, test } from "bun:test";
import { BLOCKED_BEAT_MS, whileBlocked } from "./blocked-turn";

/**
 * The pulse a blocked hook keeps, and — the part that was only ever held by
 * hand — the guarantee that it stops.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("whileBlocked", () => {
  test("says it is there before the wait begins, and again while it lasts", async () => {
    let beats = 0;
    await whileBlocked(
      async () => {
        beats += 1;
      },
      () => wait(35),
      10,
    );
    // One on entry — a session must not look offline for a whole beat while
    // somebody is being asked to answer it — and several during the wait.
    expect(beats).toBeGreaterThan(2);
  });

  test("the pulse stops when the wait does", async () => {
    let beats = 0;
    const count = async () => {
      beats += 1;
    };
    await whileBlocked(count, () => wait(30), 5);
    const afterReturn = beats;
    await wait(30);
    expect(beats).toBe(afterReturn);
  });

  test("the pulse stops when the wait throws", async () => {
    // The path that matters: a bridge that goes away mid-approval used to
    // rely on a clearInterval in a catch block, and a finished session that
    // keeps heartbeating is a dead session showing as alive on the deck.
    let beats = 0;
    const count = async () => {
      beats += 1;
    };
    await expect(
      whileBlocked(
        count,
        async () => {
          await wait(15);
          throw new Error("bridge went away");
        },
        5,
      ),
    ).rejects.toThrow("bridge went away");
    const afterThrow = beats;
    await wait(30);
    expect(beats).toBe(afterThrow);
  });

  test("a deck that goes quiet mid-wait is not a reason to stop waiting", async () => {
    // The bridge dropping for a moment must not abandon a question a person
    // is in the middle of answering.
    let beats = 0;
    const answer = await whileBlocked(
      async () => {
        beats += 1;
        if (beats > 1) throw new Error("unreachable");
      },
      async () => {
        await wait(25);
        return "answered";
      },
      5,
    );
    expect(answer).toBe("answered");
    expect(beats).toBeGreaterThan(1);
  });

  test("a deck that is already gone ends the wait, so the hook can fall back", async () => {
    // The first beat is the reachability check: if it fails there is nobody
    // to answer from, and the caller's catch is what sends the person to the
    // local permission prompt instead of blocking on nothing.
    await expect(
      whileBlocked(
        async () => {
          throw new Error("unreachable");
        },
        async () => "should not run",
        5,
      ),
    ).rejects.toThrow("unreachable");
  });

  test("the answer comes back to the caller", async () => {
    expect(
      await whileBlocked(
        async () => {},
        async () => true,
      ),
    ).toBe(true);
    expect(BLOCKED_BEAT_MS).toBeGreaterThan(0);
  });
});
