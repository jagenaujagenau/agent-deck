/**
 * When a hooks state report should claim State Authority (ADR-0002).
 *
 * Only while a deck-answerable request is genuinely open: that is the window
 * where the hooks know something a terminal observer cannot — the request,
 * its expiry, and who can resolve it — and where an observer's delayed
 * "idle" would erase a session that is really blocked. A session waiting on
 * something only the terminal can see is deliberately not claimed: there the
 * observer reading the screen is the better describer, and a hooks claim
 * would suppress it.
 */

/** A claim lasting until `expiresAt`, or nothing when that window has no time left. */
export function claimWindow(
  expiresAt: string | undefined,
  now: number,
): { ttlMs: number } | undefined {
  if (expiresAt === undefined) return undefined;
  const ttlMs = Date.parse(expiresAt) - now;
  return Number.isFinite(ttlMs) && ttlMs > 0 ? { ttlMs } : undefined;
}

/** The claim for a report of this session state: its live approval's window, or nothing. */
export function approvalClaim(
  state: { state?: string; pendingApproval?: { expiresAt: string } },
  now: number,
): { ttlMs: number } | undefined {
  if (state.state !== "waiting") return undefined;
  return claimWindow(state.pendingApproval?.expiresAt, now);
}
