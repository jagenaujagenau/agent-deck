import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where one session's files live — the single answer.
 *
 * The shim, the handler, and the daemon each used to derive this path
 * family on their own, and only the handler honoured the test override.
 * The fake-harness e2e redirected the handler's state into a scratch
 * directory while the shim went on probing the daemon socket under the
 * developer's real ~/.cache — its isolation held only because no live
 * daemon happened to own a colliding session id. One derivation, imported
 * everywhere, honours the override once and for all callers.
 */
export const sessionStateDirectory = (): string =>
  process.env.AGENT_DECK_STATE_DIR ?? join(homedir(), ".cache", "agent-deck", "runtime-hooks");

export const sessionStatePath = (agentId: string): string =>
  join(sessionStateDirectory(), `${agentId}.json`);
