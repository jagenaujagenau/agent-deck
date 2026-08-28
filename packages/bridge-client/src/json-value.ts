/**
 * The JSON value grammar, named, and the checks a refusal parser narrows it
 * with. A deliberate twin of `agent-adapter/src/json-value.ts`: this package
 * is dependency-free by design, so a consumer can vendor it whole.
 */

export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** `String` hands a string back unchanged, and everything else a different value. */
export function isJsonString(value: JsonValue | undefined): value is string {
  return String(value) === value;
}

/** `Object` boxes primitives into fresh objects; only a real object comes back as itself. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !Array.isArray(value) && Object(value) === value;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined;
}

export function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse can only produce values of the JSON grammar this type names.
  return JSON.parse(text) as JsonValue;
}
