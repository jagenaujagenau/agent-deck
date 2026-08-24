package dev.agentdeck.wear

import dev.agentdeck.shared.Agent

internal enum class WearStatePage(val label: String, val states: Set<String>) {
    Running("Running", setOf("running")),
    NeedsYou("Needs you", setOf("waiting", "error")),
    Paused("Paused", setOf("paused")),
    Idle("Idle", setOf("idle")),
}

internal fun agentsForPage(agents: List<Agent>, page: WearStatePage): List<Agent> =
    agents.filter { it.state in page.states }
