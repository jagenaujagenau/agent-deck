package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent

internal fun agentStateRank(state: String) = when (state) {
    "waiting" -> 0
    "error" -> 1
    "running" -> 2
    "paused" -> 3
    "idle" -> 4
    else -> 5
}

/** Stable across heartbeats: lastSeenAt and task are intentionally excluded. */
internal fun stableAgentOrder(agents: List<Agent>): List<Agent> = agents.sortedWith(
    compareBy<Agent> { agentStateRank(it.state) }
        .thenBy { it.project.lowercase() }
        .thenBy { it.id },
)

internal fun stableProjectOrder(groups: Map<String, List<Agent>>) = groups.entries.sortedWith(
    compareBy<Map.Entry<String, List<Agent>>> { entry -> entry.value.minOfOrNull { agentStateRank(it.state) } ?: 9 }
        .thenBy { it.key.lowercase() },
)
