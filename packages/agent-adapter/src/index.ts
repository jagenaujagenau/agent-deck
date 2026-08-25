/**
 * The package barrel.
 *
 * Adapters that only speak to the bridge should import `./client` directly:
 * this re-exports the managed Claude runtime too, which brings the Claude Agent
 * SDK with it.
 */
export * from "./runtime-events";
export * from "./runtime-projector";
export * from "./managed-runtime";
export * from "./claude-sdk-runtime";
export * from "./client";
