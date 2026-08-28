/**
 * The JSON value grammar, named, and the checks a hand-written parser narrows
 * it with.
 *
 * Everything these hooks read — the hook's stdin, session transcripts, settings
 * files — is another program's JSON. The parsers stay hand-written because a
 * hook runs on every tool call and schema machinery is too slow for that path
 * (see hook-input.ts); this module is the one place a raw representation is
 * interrogated, so those parsers can branch on values the grammar names instead
 * of probing untyped bags.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** JSON.parse, but returning what it actually produces. Throws exactly as JSON.parse does. */
export function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse can only ever produce the JSON grammar — a string,
  // number, boolean, null, array, or object of the same — which is exactly the
  // shape JsonValue names.
  return JSON.parse(text) as JsonValue;
}

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
