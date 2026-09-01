import { describe, expect, test } from "bun:test";
import { eventTime } from "./State";

/**
 * When an event goes on the record.
 *
 * The deck used to stamp every event with its arrival, which made the wire
 * unable to carry history: a seeder laying out a conversation, or an adapter
 * replaying a transcript, got one instant with everything in it.
 */

const now = "2026-09-01T12:00:00.000Z";

describe("eventTime", () => {
  test("an unsaid time means now", () => {
    expect(eventTime(undefined, now)).toBe(now);
    expect(eventTime(null, now)).toBe(now);
  });

  test("a stated time is taken, and normalised", () => {
    expect(eventTime("2026-09-01T11:30:00Z", now)).toBe("2026-09-01T11:30:00.000Z");
  });

  test("the future is refused", () => {
    // A skewed clock stamping tomorrow would sort above every real event and
    // stay pinned there, taking the newest-message divider with it.
    expect(eventTime("2030-01-01T00:00:00.000Z", now)).toBe(now);
  });

  test("now itself is not the future", () => {
    expect(eventTime(now, now)).toBe(now);
  });

  test("nonsense is treated as unsaid rather than as zero", () => {
    // Date.parse of a bad string is NaN, and NaN as a timestamp is 1970 —
    // which would bury the event at the bottom of every timeline forever.
    expect(eventTime("last tuesday", now)).toBe(now);
    expect(eventTime("", now)).toBe(now);
  });
});
