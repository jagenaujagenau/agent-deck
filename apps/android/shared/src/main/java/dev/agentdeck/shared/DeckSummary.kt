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
    /**
     * What the session is thinking, or the last thing it said.
     *
     * Not its tool activity. "Bash completed" says the machine is busy, which
     * the state already says; the reasoning or the reply is the part a person
     * glances at a widget to read.
     */
    val detail: String,
    val harness: Harness = Harness.Unknown,
    val needsYou: Boolean = false,
)

object DeckSummaries {
    /**
     * Enough lines for the largest surface that draws them, so one stored
     * summary serves a phone widget at any size and a watch tile at one.
     */
    const val MAX_LINES: Int = 8

    /** Rank 4 and above is a person's problem: an error, or a session blocked on one. */
    private fun needsYou(agent: Agent): Boolean =
        attentionPriority(agent.state, blocked = agent.state == "waiting", seen = true) >= 4

    fun of(agents: List<Agent>, observedAt: Long): DeckSummary {
        val live = agents.filter { it.state != "offline" }
        val needing = live.filter { needsYou(it) }
        val running = live.filter { it.state == "running" }

        // Attention Priority, the same ranking every scrollable surface sorts
        // by — the stuck one is always first, on every screen, including the
        // glanceable ones. Seen is held neutral: this summary is stored and
        // relayed verbatim from the phone to the watch, and Done is a
        // per-surface state — one surface's read must not decide what the
        // other's tile leads with. Within a rank, the oldest first: the
        // session stuck longest is the one most likely to stay stuck.
        val ordered = live.sortedWith(
            compareByDescending<Agent> {
                attentionPriority(it.state, blocked = it.state == "waiting", seen = true)
            }.thenBy { it.lastSeenAt },
        )
        return DeckSummary(
            lines = ordered.take(MAX_LINES).map { agent ->
                DeckLine(
                    agentId = agent.id,
                    project = agent.project.ifBlank { agent.name },
                    detail = detailFor(agent),
                    harness = Harnesses.of(agent),
                    needsYou = needsYou(agent),
                )
            },
            attention = needing.size,
            running = running.size,
            idle = live.size - needing.size - running.size,
            observedAt = observedAt,
            reachedBridge = true,
        )
    }

    /** Long enough to be worth reading, short enough for two lines on a watch. */
    private const val DETAIL_LIMIT = 140

    /**
     * What a session is thinking, or the last thing it said.
     *
     * Thinking wins only when it is the most recent thing to happen: a stale
     * thought shown beside a finished reply would report the session as still
     * working it out. Falling back to the task is what covers a relay that
     * carried no events at all - the watch is sent one event per session, and
     * it may not be either of these.
     */
    fun detailFor(agent: Agent): String {
        val latest = agent.events.maxByOrNull { it.createdAt }
        if (latest?.kind == "thought") {
            latest.detail?.takeIf { it.isNotBlank() }?.let { return clip(it) }
        }
        val reply = agent.events
            .filter { it.kind == "output" && it.summary == "Response" }
            .maxByOrNull { it.createdAt }
            ?.detail
            ?.takeIf { it.isNotBlank() }
        if (reply != null) return clip(reply)
        return agent.task.ifBlank {
            if (agent.state == "waiting") "Needs your attention" else agent.state
        }
    }

    /**
     * One line's worth, with the newlines a transcript is full of flattened
     * out and its Markdown taken off — a widget row two lines tall has no use
     * for a heading's hashes or a table's pipes.
     */
    private fun clip(value: String): String = clipAtWord(stripMarkdownForPreview(value), DETAIL_LIMIT)

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
