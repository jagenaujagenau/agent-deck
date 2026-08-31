package dev.agentdeck.shared

import android.content.Context

/**
 * One attention ranking for every list of sessions, on every surface.
 *
 * The rule, borrowed from herdr: the stuck one is always first, and "finished
 * while you weren't looking" outranks "running". A session that errored or is
 * blocked on a person cannot move without one; a session that finished unseen
 * is holding a result nobody has collected; a running session is doing fine by
 * itself; and one that finished and was read asks for nothing at all.
 *
 * `blocked` means the runtime reports `waiting` - an approval, a question, or
 * input it cannot type for itself. `seen` is the surface's own read mark, so
 * the same deck can rank differently on the phone and the watch, which is the
 * point: each wrist and pocket owes attention only to what *it* has not shown.
 *
 * The iOS app and the TypeScript client share this same ranking; parity is
 * enforced by `packages/bridge-client/fixtures/attention-parity.json`, which
 * all three run as tests. Extend the corpus, never one implementation.
 */
fun attentionPriority(state: String, blocked: Boolean, seen: Boolean): Int = when {
    state == "error" -> 5
    blocked -> 4
    state == "idle" && !seen -> 3
    state == "running" -> 2
    state == "idle" -> 1
    else -> 0
}

/** The newest instant this session did anything, on the snapshot's own clock. */
fun latestActivityAt(agent: Agent): String =
    maxOf(agent.lastSeenAt, agent.events.maxOfOrNull { it.createdAt } ?: agent.lastSeenAt)

/**
 * Whether a seen mark covers everything the session has done since.
 *
 * Timestamps are ISO-8601 UTC strings throughout the bridge, so lexical order
 * is chronological order - the same comparison AttentionPolicy already leans on.
 */
fun seenCovers(seenAt: String?, latestActivityAt: String): Boolean =
    seenAt != null && seenAt >= latestActivityAt

/**
 * Whether anyone has seen everything this session has done, on any surface.
 *
 * Two marks can cover a session: this device's own read, and the bridge's
 * `viewedAt` - the last time a person looked anywhere, which is what lets a
 * glance at the desk clear the badge on the wrist. Either mark counts, and
 * neither survives newer activity: a session that worked on after being read
 * is unseen again everywhere. Only an explicit view writes either mark; a
 * snapshot arriving is still a machine read.
 */
fun sessionSeen(agent: Agent, localSeenAt: String?): Boolean {
    val latest = latestActivityAt(agent)
    return seenCovers(localSeenAt, latest) || seenCovers(agent.viewedAt, latest)
}

/**
 * Which sessions the person holding this device has actually looked at.
 *
 * Surface-local by design - the phone tracks its own reads and the watch its
 * own - and written only when a person opens a session's screen, never when a
 * snapshot arrives or a list is drawn. A machine read must not mark anything
 * seen (herdr calls this a passive read): two surfaces sharing one mark would
 * let a glance at the watch silence the phone.
 */
class SeenStore(context: Context) {
    private val preferences =
        context.applicationContext.getSharedPreferences("seen_sessions", Context.MODE_PRIVATE)

    fun all(): Map<String, String> = preferences.all
        .mapNotNull { (key, value) -> (value as? String)?.let { key to it } }
        .toMap()

    fun seenAt(agentId: String): String? = preferences.getString(agentId, null)

    /** Records that the person is looking at this session right now. */
    fun markSeen(agentId: String, lastViewedActivityAt: String) {
        val previous = preferences.getString(agentId, null)
        // A mark never moves backwards: a stale snapshot arriving while the
        // screen is open must not un-see what a fresher one already covered.
        if (previous != null && previous >= lastViewedActivityAt) return
        preferences.edit().putString(agentId, lastViewedActivityAt).apply()
    }
}

/**
 * How long a running session has been silent, when that silence is worth
 * saying. A session claiming "running" whose runtime has produced nothing
 * for minutes is not confidently working — its agent may be hung, or its
 * hook pipe broken — and a green typing indicator over that silence is the
 * deck vouching for something it cannot see. Three minutes is past any
 * honest thinking pause: thoughts and tool calls both stream as events.
 * Null while the session is not running, or while signal still flows.
 */
fun signalSilenceMinutes(agent: Agent, nowMs: Long = System.currentTimeMillis()): Long? {
    if (agent.state != "running") return null
    val latest = runCatching { java.time.Instant.parse(latestActivityAt(agent)).toEpochMilli() }
        .getOrNull() ?: return null
    val minutes = (nowMs - latest) / 60_000
    return if (minutes >= 3) minutes else null
}
