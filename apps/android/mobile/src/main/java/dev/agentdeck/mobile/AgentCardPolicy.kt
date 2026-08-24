package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent

internal fun agentCardActivity(agent: Agent): String {
    if (agent.state == "waiting") {
        if (agent.pendingApproval != null) return "Review required"
        if (agent.events.any { it.kind == "question" }) return "Awaiting your answer"
        val remotelyMessageable = listOf("prompt", "steer", "follow_up").any { supportsCapability(agent.capabilities, it) }
        return if (remotelyMessageable) "Open session to continue" else "Input required in host runtime"
    }
    return when (agent.state) {
        "running" -> when {
            agent.task.startsWith("Using ") -> "Using ${agent.task.removePrefix("Using ")}"
            agent.task.endsWith(" completed") -> "${agent.task.removeSuffix(" completed")} finished"
            agent.task.isBlank() || agent.task == agent.objective -> "Working on instruction"
            else -> agent.task
        }
        "paused" -> "Paused by user"
        "error" -> agent.task.takeIf(String::isNotBlank) ?: "Run failed"
        "offline" -> "Session ended"
        "idle" -> if (agent.task.lowercase() in setOf("ready", "ready for an instruction")) "Ready for an instruction" else "Turn completed"
        else -> agent.task.takeIf(String::isNotBlank) ?: "No recent activity"
    }
}

internal fun latestReasoningPreview(agent: Agent, limit: Int = 120): String? {
    // Only a running agent has a current train of thought; a finished one shows its outcome instead.
    if (agent.state != "running") return null
    // Runtimes that stream reasoning leave a thought as the newest event; runtimes that recover it
    // from a transcript always land a tool result after it, and lag a call behind. Neither ordering
    // nor age tells you anything useful, so simply take the newest thought of the running turn.
    val latestThought = agent.events
        .filter { it.kind == "thought" && it.summary != "Received instruction" }
        .maxByOrNull { it.createdAt } ?: return null
    val reasoning = latestThought.detail?.let(::stripMarkdownForPreview)?.takeIf(String::isNotBlank) ?: return null
    if (reasoning.length <= limit) return reasoning
    val clipped = reasoning.take((limit - 1).coerceAtLeast(0)).trimEnd()
    return "${clipped.substringBeforeLast(' ', clipped)}…"
}

internal fun stripMarkdownForPreview(markdown: String): String {
    var value = markdown
        .replace(Regex("""!\[([^]]*)]\([^)]*\)"""), "$1")
        .replace(Regex("""\[([^]]+)]\([^)]*\)"""), "$1")
        .replace(Regex("""```[^\n]*"""), " ")
        .replace("```", " ")
        .replace(Regex("""`([^`]*)`"""), "$1")
        .replace(Regex("""(?m)^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+"""), "")
        .replace(Regex("""<[^>]+>"""), " ")
    repeat(2) {
        value = value
            .replace(Regex("""(?:\*\*|__)(.*?)(?:\*\*|__)"""), "$1")
            .replace(Regex("""(?:\*|_)(.*?)(?:\*|_)"""), "$1")
            .replace(Regex("""~~(.*?)~~"""), "$1")
    }
    return value.replace(Regex("""\s+"""), " ").trim()
}

internal fun humanizeModelId(value: String): String {
    val parts = value.split('-').filter(String::isNotBlank)
    val result = mutableListOf<String>()
    var index = 0
    while (index < parts.size) {
        val current = parts[index]
        val next = parts.getOrNull(index + 1)
        if (current.all(Char::isDigit) && next?.all(Char::isDigit) == true) {
            result += "$current.$next"
            index += 2
        } else {
            result += current.replaceFirstChar(Char::uppercase)
            index += 1
        }
    }
    return result.joinToString(" ")
}

internal fun cardFreshness(timestamp: String, now: java.time.Instant = java.time.Instant.now()): String {
    val seconds = runCatching { java.time.Duration.between(java.time.Instant.parse(timestamp), now).seconds.coerceAtLeast(0) }.getOrDefault(0)
    return when {
        seconds < 45 -> "now"
        seconds < 3_600 -> "${seconds / 60}m ago"
        seconds < 86_400 -> "${seconds / 3_600}h ago"
        else -> "${seconds / 86_400}d ago"
    }
}
