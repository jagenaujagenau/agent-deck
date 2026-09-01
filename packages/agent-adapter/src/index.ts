/**
 * The package barrel.
 *
 * Adapters that only speak to the bridge should import `./client` directly:
 * this re-exports the managed Claude runtime too, which brings the Claude Agent
 * SDK with it.
 */
export * from "./agent-identity";
// The predicates only, not the grammar's type names: the bridge names its own
// `JsonValue` in Domain.ts, and exporting a second one under the same name
// makes every importer disambiguate two identical types.
export { isJsonObject, isJsonString } from "./json-value";
export * from "./runtime-events";
export * from "./runtime-projector";
export * from "./runtime-publisher";
export * from "./user-input";
export * from "./managed-runtime";
export * from "./claude-sdk-runtime";
export * from "./client";
