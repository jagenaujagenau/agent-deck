import { readFileSync } from "node:fs";
import { isJsonNumber, isJsonObject, parseJson } from "../../packages/agent-adapter/src/json-value";

/**
 * The per-session report counter both publishers share.
 *
 * Two publishers report the same session: the event handler — run by the
 * daemon's socket server, or by a hook process that fell back to local
 * handling — and the daemon's own heartbeat loop. Either can load the state
 * file, lose its turn while the other advances the session, and then publish
 * a state report the bridge has no way to order. One counter in the shared state file gives the session a
 * single total order, and the bridge drops whichever report arrives carrying
 * a number it has already accepted.
 */

/** The origin every report from this adapter names; the bridge keys its per-source order on it. */
export const REPORT_SOURCE = "claude-hooks";

/** The slice of the session state file the counter lives in. */
export type ReportCounter = { reportSeq?: number };

/**
 * Advances the shared counter and hands back the value to stamp.
 *
 * The persisted file is consulted because the other publisher may have moved
 * the counter since this process loaded its copy; whichever count is higher
 * is the real one. The caller persists `state` with its existing save
 * mechanism. This is one small read per report — cheap enough for a counter
 * that runs on every tool call.
 */
export function nextReportSeq(statePath: string, state: ReportCounter): number {
  let persisted = 0;
  try {
    const stored = parseJson(readFileSync(statePath, "utf8"));
    if (isJsonObject(stored) && isJsonNumber(stored.reportSeq)) persisted = stored.reportSeq;
  } catch {
    /* First report for this session, or a corrupt file the next save replaces. */
  }
  state.reportSeq = Math.max(persisted, state.reportSeq ?? 0) + 1;
  return state.reportSeq;
}
