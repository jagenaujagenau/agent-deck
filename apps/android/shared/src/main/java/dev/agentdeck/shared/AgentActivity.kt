package dev.agentdeck.shared

/**
 * One line saying why a session wants attention, or what it is doing.
 *
 * Shared because the phone and the watch have to agree. A card that reads
 * "Review required" on one and shows a raw internal task string on the other
 * is two different answers to the same question, and the watch is the surface
 * where the short answer matters most.
 */
fun agentCardActivity(agent: Agent, nowMs: Long = System.currentTimeMillis()): String {
    if (agent.state == "waiting") {
        if (agent.pendingApproval != null) return "Review required"
        if (agent.pendingQuestion != null || agent.events.any { it.kind == "question" }) return "Awaiting your answer"
        val remotelyMessageable =
            listOf("prompt", "steer", "follow_up").any { supportsCapability(agent.capabilities, it) }
        return if (remotelyMessageable) "Open session to continue" else "Input required in host runtime"
    }
    return when (agent.state) {
        "running" -> when {
            // A green "working" over minutes of silence is the deck vouching
            // for something it cannot see; say the silence instead.
            signalSilenceMinutes(agent, nowMs) != null -> "No signal for ${signalSilenceMinutes(agent, nowMs)}m"
            agent.task.startsWith("Using ") -> "Using ${agent.task.removePrefix("Using ")}"
            agent.task.endsWith(" completed") -> "${agent.task.removeSuffix(" completed")} finished"
            agent.task.isBlank() || agent.task == agent.objective -> "Working on instruction"
            else -> agent.task
        }
        "paused" -> "Paused by user"
        "error" -> agent.task.takeIf(String::isNotBlank) ?: "Run failed"
        "offline" -> "Session ended"
        "idle" ->
            if (agent.task.lowercase() in setOf("ready", "ready for an instruction")) {
                "Ready for an instruction"
            } else {
                "Turn completed"
            }
        else -> agent.task.takeIf(String::isNotBlank) ?: "No recent activity"
    }
}

/** Whether a runtime advertises an action. An absent list means it advertises nothing. */
fun supportsCapability(capabilities: List<String>?, action: String): Boolean =
    capabilities?.contains(action) == true
