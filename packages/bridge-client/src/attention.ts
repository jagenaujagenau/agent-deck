import type { Agent } from "./types";

/**
 * One attention ranking for every list of sessions, on every surface.
 *
 * The rule, borrowed from herdr: the stuck one is always first, and "finished
 * while you weren't looking" outranks "running". A session that errored or is
 * blocked on a person cannot move without one; a session that finished unseen
 * is holding a result nobody has collected; a running session is doing fine by
 * itself; and one that finished and was read asks for nothing at all.
 *
 * Kept in step with AttentionRank.kt and AttentionPolicy.swift.
 */
export function attentionPriority(state: string, blocked: boolean, seen: boolean): number {
  if (state === "error") return 5;
  if (blocked) return 4;
  if (state === "idle" && !seen) return 3;
  if (state === "running") return 2;
  if (state === "idle") return 1;
  return 0;
}

/** The newest instant this session did anything, on the snapshot's own clock. */
export function latestActivityAt(agent: Agent): string {
  let latest = agent.lastSeenAt;
  for (const event of agent.events) if (event.createdAt > latest) latest = event.createdAt;
  return latest;
}

/**
 * Whether a seen mark covers everything the session has done since.
 *
 * Timestamps are ISO-8601 UTC strings throughout the bridge, so lexical order
 * is chronological order.
 */
export function seenCovers(seenAt: string | undefined, latestAt: string): boolean {
  return seenAt !== undefined && seenAt >= latestAt;
}

/**
 * Whether anyone has seen everything this session has done, on any surface.
 *
 * Two marks can cover a session: this client's own read, and the bridge's
 * `viewedAt` — the last time a person looked anywhere, which is what lets a
 * glance at the desk clear the badge on the wrist. Either mark counts, and
 * neither survives newer activity. Only an explicit view writes either mark;
 * a snapshot arriving is still a machine read.
 */
export function sessionSeen(agent: Agent, localSeenAt?: string): boolean {
  const latest = latestActivityAt(agent);
  return seenCovers(localSeenAt, latest) || seenCovers(agent.viewedAt, latest);
}
