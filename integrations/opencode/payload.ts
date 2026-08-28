/**
 * What an OpenCode event payload can actually hold.
 *
 * OpenCode hands this plugin plain JSON-serialisable objects, so JSON's own
 * vocabulary is the honest type for a field nothing has vouched for yet. The
 * helpers below are the boundary: everything the plugin reads off a payload
 * goes through one of them, and past that point only domain values circulate.
 */

export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** True when a payload value is an object rather than a primitive or an array. */
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
