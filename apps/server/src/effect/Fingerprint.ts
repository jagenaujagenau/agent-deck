import { createHash } from "node:crypto"

/**
 * A stable identity for one agent's rendered state, used to decide whether a
 * connected device needs to be told about it again. Comparing these is far
 * cheaper than resending the agent.
 */
export const agentFingerprint = (agent: Record<string, unknown>): string =>
  createHash("sha1").update(JSON.stringify(agent)).digest("base64")
