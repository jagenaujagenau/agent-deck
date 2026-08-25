package dev.agentdeck.shared

import java.time.Duration
import java.time.Instant

/**
 * How a session's raw events become a conversation and a train of thought.
 *
 * Shared because the phone and the watch have to show the same session. A
 * conversation assembled twice is two conversations, and the watch is where a
 * discrepancy is hardest to notice and least excusable - it is the surface a
 * person checks precisely because they are not at the machine.
 */

enum class ConversationRole { User, Agent }

data class ConversationEntry(
    val event: AgentEvent,
    val role: ConversationRole,
    val content: String,
)

fun conversationEntries(events: List<AgentEvent>): List<ConversationEntry> {
    val entries = events.sortedBy { it.createdAt }.mapNotNull { event ->
        val userMessage = event.summary.startsWith("Remote command:") || event.kind == "user" ||
            (event.kind == "thought" && event.summary == "Received instruction")
        val agentResponse = isAgentResponse(event)
        when {
            userMessage && !event.detail.isNullOrBlank() -> ConversationEntry(event, ConversationRole.User, event.detail.orEmpty().trim())
            agentResponse -> (event.detail ?: event.summary).trim().takeIf { it.isNotBlank() }
                ?.let { ConversationEntry(event, ConversationRole.Agent, it) }
            else -> null
        }
    }
    return entries.fold(mutableListOf()) { result, entry ->
        val previous = result.lastOrNull()
        val duplicateRemoteDelivery = previous?.role == ConversationRole.User && entry.role == ConversationRole.User &&
            previous.content == entry.content && closeInTime(previous.event.createdAt, entry.event.createdAt)
        if (!duplicateRemoteDelivery) result += entry
        result
    }
}

/**
 * The session view's event source: the bridge's retained history plus anything the live snapshot
 * has that has not been fetched yet. The live copy wins on id, since an event can be revised after
 * it is first published (a tool's diff arrives with its completion).
 */
fun mergeSessionEvents(history: List<AgentEvent>, live: List<AgentEvent>): List<AgentEvent> {
    if (history.isEmpty()) return live
    val byId = LinkedHashMap<String, AgentEvent>(history.size + live.size)
    for (event in history) byId[event.id] = event
    for (event in live) {
        val known = byId[event.id]
        // The live copy is fresher and normally wins, but the snapshot is a lossy view of the same
        // event: it clips `detail` so a card stays small, and drops `command` and `diff` outright.
        // Taking it wholesale replaces a whole message with its first 400 characters, and strips
        // the command off a terminal entry - which then fails the Terminal tab's filter and
        // disappears from the list entirely.
        byId[event.id] = if (known == null) {
            event
        } else {
            event.copy(
                detail = if (isClippedForm(event.detail, known.detail)) known.detail else event.detail,
                command = event.command ?: known.command,
                diff = event.diff ?: known.diff,
            )
        }
    }
    return byId.values.sortedBy { it.createdAt }
}

/**
 * Whether `live` is the snapshot's shortened form of `full`.
 *
 * The snapshot cuts `detail` and marks the cut with an ellipsis, so its text is a prefix of what
 * history holds. Restoring only that exact shape leaves a genuine revision alone — an event whose
 * text was rewritten to something shorter still takes the live copy.
 */
private fun isClippedForm(live: String?, full: String?): Boolean {
    if (live == null || full == null || !live.endsWith('\u2026')) return false
    return full.length > live.length && full.startsWith(live.dropLast(1).trimEnd())
}

fun reasoningEvents(events: List<AgentEvent>): List<AgentEvent> =
    events.sortedBy { it.createdAt }.filter {
        it.kind == "thought" && it.summary != "Received instruction" && !it.detail.isNullOrBlank()
    }

fun remoteMessageAction(state: String, supports: (String) -> Boolean): String? = when {
    state in listOf("running", "waiting") && supports("steer") -> "steer"
    state in listOf("running", "waiting") && supports("follow_up") -> "follow_up"
    supports("prompt") -> "prompt"
    supports("follow_up") -> "follow_up"
    else -> null
}

private fun isAgentResponse(event: AgentEvent) = event.kind == "output" && !event.summary.startsWith("Remote command:") && event.tool == null && event.command == null &&
    (event.summary == "Response" || !event.detail.isNullOrBlank() || (event.summary != "Activity" && !event.summary.endsWith(" completed")))

private fun closeInTime(first: String, second: String): Boolean = runCatching {
    Duration.between(Instant.parse(first), Instant.parse(second)).abs() < Duration.ofSeconds(10)
}.getOrDefault(false)
