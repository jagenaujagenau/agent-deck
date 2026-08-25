package dev.agentdeck.shared

import kotlinx.serialization.Serializable

/**
 * The deck reduced to what a widget has room for.
 *
 * Shared because the phone widget and the watch tile must not disagree about
 * how many sessions want you: two glanceable surfaces showing different counts
 * is worse than either being wrong, since neither can be trusted afterwards.
 * The same reasoning put [AttentionPolicy] here.
 *
 * Serializable because a widget is not a running app. It is drawn from whatever
 * was last written down, often while nothing is connected to the bridge, so the
 * summary has to survive on disk between updates.
 */
@Serializable
data class DeckSummary(
    /** The ones there is room to name, longest wait first. */
    val needing: List<NeedsYou> = emptyList(),
    /**
     * How many are waiting in total, which is not `needing.size`.
     *
     * Kept separate because the list is capped at what a widget can draw and
     * the count is not: deriving one from the other made six waiting sessions
     * display as three, quietly reporting that the other three were fine.
     */
    val attention: Int = 0,
    val running: Int = 0,
    val idle: Int = 0,
    /** When this was taken, so a stale widget can admit it. */
    val observedAt: Long = 0L,
    /** Absent until the bridge has been reached once. */
    val reachedBridge: Boolean = false,
) {
    /** The whole deck, once every session is counted somewhere. */
    val total: Int get() = attention + running + idle
}

/** One session asking for a person, named the way a person would recognise it. */
@Serializable
data class NeedsYou(
    val agentId: String,
    /** Project rather than the full session name: it is what fits and what identifies. */
    val project: String,
    /** What it is waiting on - an approval, a question, a prompt in the terminal. */
    val asking: String,
)

/**
 * Reduces a snapshot to the summary a widget draws.
 *
 * Attention is decided by [AttentionPolicy]'s own vocabulary rather than a
 * second reading of `state`: a session is waiting because something is
 * genuinely unanswered, and the policy is where that judgement already lives.
 */
object DeckSummaries {
    /** More than this and a widget is a list, not a glance. */
    const val MAX_NEEDING: Int = 3

    fun of(agents: List<Agent>, observedAt: Long): DeckSummary {
        val live = agents.filter { it.state != "offline" }
        val needing = live
            .filter { it.state == "waiting" }
            // Oldest first: the one that has been waiting longest is the one
            // most likely to have stopped making progress.
            .sortedBy { it.lastSeenAt }
            .map {
                NeedsYou(
                    agentId = it.id,
                    project = it.project.ifBlank { it.name },
                    asking = it.task.ifBlank { "Needs your attention" },
                )
            }
        return DeckSummary(
            needing = needing.take(MAX_NEEDING),
            attention = needing.size,
            running = live.count { it.state == "running" },
            idle = live.count { it.state != "waiting" && it.state != "running" },
            observedAt = observedAt,
            reachedBridge = true,
        )
    }

    /**
     * The line a widget shows when nothing is asking for you.
     *
     * Deliberately not "0 need you". A widget that reports zero of something is
     * reporting a problem it does not have; what is true is that work is going
     * on, or that nothing is.
     */
    fun restingLine(summary: DeckSummary): String = when {
        !summary.reachedBridge -> "Not connected"
        summary.running > 0 -> "${summary.running} working"
        summary.total == 0 -> "No sessions"
        else -> "All idle"
    }

    /**
     * How many more are waiting than the widget had room for.
     *
     * Reported rather than dropped: a widget that silently shows three of five
     * is telling you that two sessions do not need you, which is a lie.
     */
    fun overflow(summary: DeckSummary, shown: Int): Int = (summary.attention - shown).coerceAtLeast(0)
}
