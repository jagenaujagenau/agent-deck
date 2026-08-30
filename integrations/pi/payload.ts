/**
 * What a Pi event can actually carry.
 *
 * Tool inputs and message content arrive from the runtime as plain
 * JSON-serialisable values, so JSON's own vocabulary is the honest type for a
 * field nothing has vouched for yet. These helpers are the boundary: every read
 * off such a value goes through one of them, and past that point only domain
 * values circulate.
 */

export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;

// Reads come back `JsonValue | undefined` through noUncheckedIndexedAccess, so
// the index signature stays plain JsonValue and the type remains assignable to
// the adapter's own JsonObject.
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** True when an event value is an object rather than a primitive or an array. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && !Array.isArray(value) && Object(value) === value;
}

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

/**
 * The value itself when it is a string. `String()` hands back the very same
 * primitive for a string and something new for everything else, which makes the
 * identity comparison the whole test.
 */
export function asString(value: JsonValue | undefined): string | undefined {
  const coerced = String(value);
  return coerced === value ? coerced : undefined;
}

/**
 * The Pi SDK's typed content and tool arguments, re-admitted through the
 * JSON grammar the honest way: a serialization round trip. The SDK parsed
 * this data from JSON in the first place, so the trip is lossless where it
 * matters and costs one stringify per event, not per token. Absent input is
 * an empty document rather than a parse error.
 */
export function fromSdkJson(value: { toString(): string } | string | null | undefined): JsonValue {
  const text = JSON.stringify(value);
  return text === undefined ? null : parseJson(text);
}

/** JSON.parse, but returning what it actually produces. Throws exactly as JSON.parse does. */
function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse can only ever produce the JSON grammar — a string,
  // number, boolean, null, array, or object of the same — which is exactly
  // the shape JsonValue names.
  return JSON.parse(text) as JsonValue;
}
