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
