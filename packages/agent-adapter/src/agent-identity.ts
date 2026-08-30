import { createHash } from "node:crypto";

/**
 * The deck's name for a session — the one correlation key the whole system
 * stands on.
 *
 * Every subsystem that meets the same session — the hooks and their daemon,
 * herdr reading the terminal, the transcript scanner, the bridge — derives
 * the same id from the runtime's own session id, so they agree without ever
 * publishing a mapping. That only works while there is exactly one way to
 * derive it: five copies of this expression once lived across the
 * integrations, which is precisely how a correlation scheme drifts.
 */

/** The hashed half of an agent id, exposed for the places that use it alone. */
export function sessionKey(sessionSeed: string): string {
  return createHash("sha256").update(sessionSeed).digest("hex").slice(0, 24);
}

export function agentIdFor(runtime: string, sessionSeed: string): string {
  return `${runtime}-${sessionKey(sessionSeed)}`;
}
