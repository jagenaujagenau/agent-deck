package dev.agentdeck.wear

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.attentionPriority
import dev.agentdeck.shared.sessionSeen

internal enum class WearStatePage(val label: String, val states: Set<String>) {
    Running("Running", setOf("running")),
    NeedsYou("Needs you", setOf("waiting", "error")),
    Paused("Paused", setOf("paused")),
    Idle("Idle", setOf("idle")),
}

/**
 * The page a raised wrist lands on: wherever the deck's highest-ranked
 * session lives, by the shared attention order.
 *
 * The pager used to open on Running whatever the deck held, so a wrist
 * raised *because it buzzed* still had to swipe to reach the approval. The
 * stuck one is always first, on every screen — on a watch, that means the
 * first page shown: an error or a blocked session lands on Needs you, a
 * finish this wrist has not seen lands on Idle where it floats on top, and
 * only a deck with nothing to say opens on Running.
 */
internal fun landingPage(
    agents: List<Agent>,
    seenMarks: Map<String, String> = emptyMap(),
): WearStatePage {
    val lead = agents.maxByOrNull {
        attentionPriority(it.state, it.state == "waiting", sessionSeen(it, seenMarks[it.id]))
    }
    return WearStatePage.entries.firstOrNull { lead != null && lead.state in it.states }
        ?: WearStatePage.Running
}

/**
 * One page's agents, in the shared attention order.
 *
 * `seenMarks` are this watch's own reads - opening a session here marks it here
 * and nowhere else - so the Idle page floats "finished while you weren't
 * looking" above what this wrist has already been shown, and the Needs-you
 * page puts the stuck (errored) sessions first.
 */
internal fun agentsForPage(
    agents: List<Agent>,
    page: WearStatePage,
    seenMarks: Map<String, String> = emptyMap(),
): List<Agent> = agents
    .filter { it.state in page.states }
    .sortedWith(
        compareByDescending<Agent> {
            attentionPriority(it.state, it.state == "waiting", sessionSeen(it, seenMarks[it.id]))
        }
            .thenBy { it.project.lowercase() }
            .thenBy { it.id },
    )
