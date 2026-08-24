package dev.agentdeck.mobile

import android.content.Context
import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.BridgeSnapshot

internal fun agentArchiveKey(agent: Agent) = agent.id

internal fun normalizeArchivedAgentKeys(keys: Set<String>): Set<String> = keys.mapTo(mutableSetOf()) { it.substringBefore(':') }

internal fun unarchivedAgents(agents: List<Agent>, archivedKeys: Set<String>) = agents.filterNot { agentArchiveKey(it) in archivedKeys }

internal fun attentionCount(agents: List<Agent>) = agents.count { it.state == "waiting" || it.state == "error" }

internal fun archiveFilteredSnapshot(context: Context, snapshot: BridgeSnapshot): BridgeSnapshot {
    val archived = normalizeArchivedAgentKeys(context.getSharedPreferences("bridge", Context.MODE_PRIVATE).getStringSet("archived_agents", emptySet())?.toSet() ?: emptySet())
    return archiveFilteredSnapshot(snapshot, archived)
}

internal fun archiveFilteredSnapshot(snapshot: BridgeSnapshot, archived: Set<String>): BridgeSnapshot {
    val agents = unarchivedAgents(snapshot.agents, archived)
    return snapshot.copy(
        agents = agents,
        summary = snapshot.summary.copy(
            active = agents.count { it.state in listOf("running", "waiting", "paused") },
            waiting = agents.count { it.state == "waiting" },
            errors = agents.count { it.state == "error" },
        ),
    )
}

/** Compact phone-owned projection kept well below the Wear Data Layer item limit. */
internal fun wearRelaySnapshot(context: Context, snapshot: BridgeSnapshot): BridgeSnapshot {
    val archived = normalizeArchivedAgentKeys(context.getSharedPreferences("bridge", Context.MODE_PRIVATE).getStringSet("archived_agents", emptySet())?.toSet() ?: emptySet())
    return wearRelaySnapshot(snapshot, archived)
}

internal fun wearRelaySnapshot(snapshot: BridgeSnapshot, archived: Set<String>): BridgeSnapshot {
    val visible = archiveFilteredSnapshot(snapshot, archived)
    val agents = visible.agents.filter { it.state != "offline" }.map { agent ->
        val latest = agent.events.maxByOrNull { it.createdAt }?.let { event ->
            event.copy(
                detail = event.detail?.take(1_200),
                command = event.command?.take(1_200),
                diff = event.diff?.take(1_200),
            )
        }
        agent.copy(events = listOfNotNull(latest))
    }
    return visible.copy(
        agents = agents,
        summary = visible.summary.copy(
            active = agents.count { it.state in listOf("running", "waiting", "paused") },
            waiting = agents.count { it.state == "waiting" },
            errors = agents.count { it.state == "error" },
        ),
    )
}
