package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.ConversationRole
import dev.agentdeck.shared.agentCardActivity
import dev.agentdeck.shared.conversationEntries
import dev.agentdeck.shared.signalSilenceMinutes
import dev.agentdeck.shared.supportsCapability
import dev.agentdeck.shared.usefulTask

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
        seconds < 3_600 -> "${(seconds / 60).coerceAtLeast(1)}m ago"
        seconds < 86_400 -> "${seconds / 3_600}h ago"
        else -> "${seconds / 86_400}d ago"
    }
}

/**
 * The preview line: the last thing said in this conversation. A session that
 * is asking shows its question; a running one shows what it is doing — the
 * "typing…" of an agent; otherwise the newest message speaks, prefixed
 * "You:" when the person spoke last, exactly as a chat list would.
 */
internal fun chatPreview(agent: Agent, state: HomeAgentState): String {
    // The old card wore a status chip that said "Approval required"; without
    // it, a bare command in amber would not say what is being asked of you.
    if (state == HomeAgentState.ApprovalRequired) return "Approve? ${usefulTask(agent)}"
    if (state.attention || state == HomeAgentState.Failed) return usefulTask(agent)
    // Silence outranks a stale train of thought: the newest reasoning of a
    // runtime that has gone mute reads as live work that is not happening.
    if (state == HomeAgentState.Running && signalSilenceMinutes(agent) != null) return agentCardActivity(agent)
    if (state == HomeAgentState.Running) return latestReasoningPreview(agent) ?: agentCardActivity(agent)
    val last = conversationEntries(agent.events).lastOrNull() ?: return usefulTask(agent)
    val line = last.content.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: return usefulTask(agent)
    return if (last.role == ConversationRole.User) "You: $line" else line
}
