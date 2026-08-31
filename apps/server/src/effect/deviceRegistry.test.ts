import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlClient } from "effect/unstable/sql";
import {
  DEVICE_PRESENT_WITHIN_MS,
  PAIRING_FAILURE_LIMIT,
  makeDeviceRegistry,
} from "./DeviceRegistry";
import { BridgeSchema } from "./Schema";

/**
 * The credential lifecycle, driven directly.
 *
 * The brute-force lockout in particular has never had a test: reaching it
 * meant pairing eleven times against a running bridge, so the rule that
 * keeps a six-digit code from being walked through was carried by a comment
 * and nothing else.
 */

const withRegistry = <A>(
  body: (registry: ReturnType<typeof makeDeviceRegistry>) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* body(
      makeDeviceRegistry({ sql, now: () => new Date().toISOString() }, yield* Ref.make(0)),
    );
  }).pipe(
    Effect.provide(BridgeSchema),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.runPromise,
  );

describe("pairing", () => {
  test("a code is good exactly once", async () => {
    const [first, second] = await withRegistry((registry) =>
      Effect.gen(function* () {
        const { code } = yield* registry.issueCode();
        return [
          yield* registry.pair(code, "Pixel"),
          // The same code again: a one-time code that worked twice would be
          // a credential anyone who saw the QR could keep using.
          yield* registry.pair(code, "Somebody else"),
        ] as const;
      }),
    );
    expect(first?.name).toBe("Pixel");
    expect(first?.token).toContain(".");
    expect(second).toBeUndefined();
  });

  test("issuing a code retires the one before it", async () => {
    const [old, fresh] = await withRegistry((registry) =>
      Effect.gen(function* () {
        const first = yield* registry.issueCode();
        const second = yield* registry.issueCode();
        // Two live codes would be two ways in, and only the newest is ever
        // shown at the desk.
        return [
          yield* registry.pair(first.code, "Old"),
          yield* registry.pair(second.code, "New"),
        ] as const;
      }),
    );
    expect(old).toBeUndefined();
    expect(fresh?.name).toBe("New");
  });

  test("wrong codes lock pairing until a new one is issued", async () => {
    const [lockedOut, afterReissue] = await withRegistry((registry) =>
      Effect.gen(function* () {
        const { code } = yield* registry.issueCode();
        for (let attempt = 0; attempt < PAIRING_FAILURE_LIMIT; attempt += 1) {
          yield* registry.pair("000000", "Guesser");
        }
        // The right code, refused: the lockout does not care that this one
        // would have worked.
        const lockedOut = yield* registry.pair(code, "Pixel");
        const reissued = yield* registry.issueCode();
        return [lockedOut, yield* registry.pair(reissued.code, "Pixel")] as const;
      }),
    );
    expect(lockedOut).toBeUndefined();
    // Issuing a code is a person at the desk, which is what clears the count.
    expect(afterReissue?.name).toBe("Pixel");
  });

  test("a good code clears the failures before it", async () => {
    const paired = await withRegistry((registry) =>
      Effect.gen(function* () {
        const { code } = yield* registry.issueCode();
        for (let attempt = 0; attempt < PAIRING_FAILURE_LIMIT - 1; attempt += 1) {
          yield* registry.pair("000000", "Fat fingers");
        }
        yield* registry.pair(code, "Pixel");
        // Nine mistypes then success must not leave the next person one
        // mistake from a lockout.
        const next = yield* registry.issueCode();
        for (let attempt = 0; attempt < PAIRING_FAILURE_LIMIT - 1; attempt += 1) {
          yield* registry.pair("000000", "Again");
        }
        return yield* registry.pair(next.code, "Watch");
      }),
    );
    expect(paired?.name).toBe("Watch");
  });
});

describe("credentials", () => {
  test("a paired token is recognised, and a revoked one never again", async () => {
    const [recognised, afterRevoke, revokedTwice] = await withRegistry((registry) =>
      Effect.gen(function* () {
        const { code } = yield* registry.issueCode();
        const device = yield* registry.pair(code, "Pixel");
        const recognised = yield* registry.recognise(device!.token);
        yield* registry.revokeByToken(device!.token);
        return [
          recognised,
          yield* registry.recognise(device!.token),
          // Revoking what is already revoked is not a second revocation.
          yield* registry.revokeByToken(device!.token),
        ] as const;
      }),
    );
    expect(recognised?.scopes).toEqual(["read", "control"]);
    expect(afterRevoke).toBeUndefined();
    expect(revokedTwice).toBe(false);
  });

  test("the desk can revoke a device it can only see by id", async () => {
    const [revoked, remaining] = await withRegistry((registry) =>
      Effect.gen(function* () {
        const { code } = yield* registry.issueCode();
        const device = yield* registry.pair(code, "Old phone");
        return [yield* registry.revokeById(device!.id), yield* registry.list()] as const;
      }),
    );
    expect(revoked).toBe(true);
    // A revoked device is gone from the desk, not greyed out on it.
    expect(remaining).toEqual([]);
  });

  test("a token nobody minted is nobody's", async () => {
    const recognised = await withRegistry((registry) => registry.recognise("not-a-token"));
    expect(recognised).toBeUndefined();
  });

  test("being recognised is what makes a device present", async () => {
    const listed = await withRegistry((registry) =>
      Effect.gen(function* () {
        const { code } = yield* registry.issueCode();
        const device = yield* registry.pair(code, "Pixel");
        yield* registry.recognise(device!.token);
        return yield* registry.list();
      }),
    );
    // No device reports itself: the desk's dot is true because every
    // authorised call touches the row.
    expect(listed[0]?.present).toBe(true);
    expect(DEVICE_PRESENT_WITHIN_MS).toBeGreaterThan(0);
  });
});
