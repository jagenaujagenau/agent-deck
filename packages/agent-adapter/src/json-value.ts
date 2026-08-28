/**
 * The JSON value grammar, named, and the checks a hand-written parser narrows
 * it with.
 *
 * Everything this package carries across a process boundary — runtime events
 * on the bridge wire, tool inputs off the Claude subprocess's stdout, answers
 * a device posted — is JSON. This module is the one place a raw representation
 * is interrogated, so the rest of the package can branch on values the grammar
 * names instead of probing untyped bags.
 */

export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** `String` hands a string back unchanged, and everything else a different value. */
export function isJsonString(value: JsonValue | undefined): value is string {
  return String(value) === value;
}

/** JSON has no NaN, so a number — and nothing else — strictly equals its own coercion. */
export function isJsonNumber(value: JsonValue | undefined): value is number {
  return Number(value) === value;
}

/** `Object` boxes primitives into fresh objects; only a real object comes back as itself. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !Array.isArray(value) && Object(value) === value;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined;
}
