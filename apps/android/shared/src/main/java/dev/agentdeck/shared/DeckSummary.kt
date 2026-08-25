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
    /**
     * The deck itself, most worth seeing first.
     *
     * Not only the sessions asking for you. A widget that listed nothing but
     * those is blank whenever the answer is "none", which is most of the time -
     * and a card that is empty most of the time reads as broken rather than
     * calm. What the sessions are doing is worth the space when nothing needs
     * doing about them.
     */
    val lines: List<DeckLine> = emptyList(),
    /**
     * How many are waiting in total, which is not the number of waiting lines.
     *
     * Kept separate because the list is capped at what a surface can draw and
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

    /** Only the ones asking for a person, which is all a small screen shows. */
    val needing: List<DeckLine> get() = lines.filter { it.needsYou }
}

/** One session, named the way a person would recognise it. */
@Serializable
data class DeckLine(
    val agentId: String,
    /** Project rather than the full session name: it is what fits and what identifies. */
    val project: String,
    /** What it is waiting on, or what it is doing. */
    val detail: String,
    val needsYou: Boolean = false,
)

object DeckSummaries {
    /**
     * Enough lines for the largest surface that draws them, so one stored
     * summary serves a phone widget at any size and a watch tile at one.
     */
    const val MAX_LINES: Int = 8

    fun of(agents: List<Agent>, observedAt: Long): DeckSummary {
        val live = agents.filter { it.state != "offline" }
        val waiting = live.filter { it.state == "waiting" }
        val running = live.filter { it.state == "running" }
        val resting = live.filter { it.state != "waiting" && it.state != "running" }

        // Waiting first, and oldest first within it: the session that has been
        // waiting longest is the one most likely to have stopped making
        // progress. Then what is working, then what is not.
        val ordered = waiting.sortedBy { it.lastSeenAt } + running + resting
        return DeckSummary(
            lines = ordered.take(MAX_LINES).map { agent ->
                DeckLine(
                    agentId = agent.id,
                    project = agent.project.ifBlank { agent.name },
                    detail = agent.task.ifBlank {
                        if (agent.state == "waiting") "Needs your attention" else agent.state
                    },
                    needsYou = agent.state == "waiting",
                )
            },
            attention = waiting.size,
            running = running.size,
            idle = resting.size,
            observedAt = observedAt,
            reachedBridge = true,
        )
    }

    /**
     * The line a surface leads with.
     *
     * Deliberately never "0 need you". A widget reporting zero of something is
     * reporting a problem it does not have; what is true is that work is going
     * on, or that nothing is.
     */
    fun headline(summary: DeckSummary): String = when {
        !summary.reachedBridge -> "Not connected"
        summary.attention == 1 -> "1 needs you"
        summary.attention > 1 -> "${summary.attention} need you"
        summary.running > 0 -> "${summary.running} working"
        summary.total == 0 -> "No sessions"
        else -> "All idle"
    }

    /**
     * How many sessions a surface did not have room for.
     *
     * Reported rather than dropped: a widget showing three of eight without a
     * word is telling you the deck has three sessions.
     */
    fun overflow(summary: DeckSummary, shown: Int): Int = (summary.total - shown).coerceAtLeast(0)
}
