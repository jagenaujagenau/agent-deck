import { createHash, randomBytes, randomInt } from "node:crypto";
import { Effect, Ref } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/**
 * The one owner of paired devices (`bridge_devices`) and the codes that mint
 * them (`bridge_pairing_codes`).
 *
 * A credential's whole life is here: a code issued at the desk, consumed
 * once for a token, the token recognised on every call it makes, and revoked
 * by either end. The lifecycle used to have three owners — pairing and
 * revocation in BridgeState, recognition and the last-seen touch in the
 * Authorizer, and the definition of "connected now" in the pairing page's
 * own JavaScript, reading a column only the Authorizer wrote. Three files,
 * one concept, and the brute-force lockout had no test at all because
 * reaching it meant pairing eleven times against a running bridge.
 *
 * What stays outside: who may call what. `routePolicy` is policy about
 * routes; this is the registry those decisions are made against.
 */

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * How many refused codes lock pairing until a new one is issued. A six-digit
 * code is a million guesses; ten wrong answers is a person mistyping, and
 * the eleventh is somebody working through the space.
 */
export const PAIRING_FAILURE_LIMIT = 10;

/** How long a minted code stands before it is nobody's. */
const PAIRING_CODE_TTL_MS = 10 * 60_000;

/**
 * How recently a device must have called for the desk to show it as here.
 *
 * Every authorised call touches `last_seen_at`, and the phone polls often
 * enough that two minutes of silence means the app is not open. Named here
 * rather than in the page's script, where it was a bare `120000` beside a
 * date subtraction.
 */
export const DEVICE_PRESENT_WITHIN_MS = 2 * 60_000;

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  /** Whether this device has called recently enough to be counted as here. */
  present: boolean;
}

export interface DeviceRegistryDeps {
  readonly sql: SqlClient.SqlClient;
  readonly now: () => string;
}

export const makeDeviceRegistry = (deps: DeviceRegistryDeps, failuresRef: Ref.Ref<number>) => {
  const { sql, now } = deps;

  /**
   * Exchanges a one-time code for a device credential, or nothing.
   *
   * Nothing is the answer to every refusal — an unknown code, a consumed
   * one, an expired one, and a locked-out caller alike — because telling a
   * guesser which of those it was is telling them whether to keep guessing.
   */
  const pair = Effect.fn("DeviceRegistry.pair")(function* (code: string, deviceName: string) {
    if ((yield* Ref.get(failuresRef)) >= PAIRING_FAILURE_LIMIT) return undefined;
    const codeHash = hash(code);
    const rows = yield* sql<{ expires_at: string; consumed_at: string | null }>`
      SELECT expires_at, consumed_at FROM bridge_pairing_codes WHERE code_hash = ${codeHash}`;
    const pairing = rows[0];
    if (!pairing || pairing.consumed_at || Date.parse(pairing.expires_at) < Date.now()) {
      yield* Ref.update(failuresRef, (count) => count + 1);
      return undefined;
    }
    yield* Ref.set(failuresRef, 0);
    const id = crypto.randomUUID();
    const token = `${randomBytes(24).toString("base64url")}.${id}`;
    const timestamp = now();
    yield* sql`UPDATE bridge_pairing_codes SET consumed_at = ${timestamp} WHERE code_hash = ${codeHash}`;
    yield* sql`INSERT INTO bridge_devices (id, name, token_hash, created_at, last_seen_at)
               VALUES (${id}, ${deviceName}, ${hash(token)}, ${timestamp}, ${timestamp})`;
    return { id, token, name: deviceName, createdAt: timestamp };
  }, Effect.orDie);

  /**
   * Whether this credential is a live device's, and which scopes it holds.
   *
   * Recognising a token is also the moment we learn the device is here, so
   * the last-seen touch happens on the same pass — which is what makes the
   * desk's presence dot true without any device reporting itself.
   */
  const recognise = Effect.fn("DeviceRegistry.recognise")(function* (token: string) {
    const rows = yield* sql<{ id: string; scopes: string }>`
      SELECT id, scopes FROM bridge_devices
      WHERE token_hash = ${hash(token)} AND revoked_at IS NULL`;
    const device = rows[0];
    if (device === undefined) return undefined;
    yield* sql`UPDATE bridge_devices SET last_seen_at = ${now()} WHERE id = ${device.id}`;
    return { id: device.id, scopes: device.scopes.split(",") };
  }, Effect.orDie);

  const revokeByToken = Effect.fn("DeviceRegistry.revokeByToken")(function* (token: string) {
    const rows = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM bridge_devices
      WHERE token_hash = ${hash(token)} AND revoked_at IS NULL`;
    if ((rows[0]?.n ?? 0) === 0) return false;
    yield* sql`UPDATE bridge_devices SET revoked_at = ${now()}
               WHERE token_hash = ${hash(token)} AND revoked_at IS NULL`;
    return true;
  }, Effect.orDie);

  const revokeById = Effect.fn("DeviceRegistry.revokeById")(function* (id: string) {
    const rows = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM bridge_devices WHERE id = ${id} AND revoked_at IS NULL`;
    if ((rows[0]?.n ?? 0) === 0) return false;
    yield* sql`UPDATE bridge_devices SET revoked_at = ${now()}
               WHERE id = ${id} AND revoked_at IS NULL`;
    return true;
  }, Effect.orDie);

  /** Every device holding a live credential, most recently seen first. */
  const list = Effect.fn("DeviceRegistry.list")(function* () {
    const rows = yield* sql<{
      id: string;
      name: string;
      created_at: string;
      last_seen_at: string;
    }>`SELECT id, name, created_at, last_seen_at FROM bridge_devices
       WHERE revoked_at IS NULL ORDER BY last_seen_at DESC`;
    const timestamp = Date.now();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      present: timestamp - Date.parse(row.last_seen_at) < DEVICE_PRESENT_WITHIN_MS,
    }));
  }, Effect.orDie);

  /**
   * Issues a fresh code, retiring any unconsumed one — two live codes would
   * mean two ways in, and only the newest was ever shown at the desk. The
   * code is logged because reading this machine's log is the trust boundary
   * pairing has always had.
   */
  const issueCode = Effect.fn("DeviceRegistry.issueCode")(function* () {
    yield* sql`DELETE FROM bridge_pairing_codes WHERE consumed_at IS NULL`;
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
    yield* sql`INSERT INTO bridge_pairing_codes (code_hash, expires_at)
               VALUES (${hash(code)}, ${expiresAt})`;
    yield* Ref.set(failuresRef, 0);
    yield* Effect.log(`Pairing code: ${code} (expires in 10 minutes)`);
    return { code, expiresAt };
  }, Effect.orDie);

  return { pair, recognise, revokeByToken, revokeById, list, issueCode };
};
