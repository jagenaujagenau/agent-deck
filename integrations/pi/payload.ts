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
