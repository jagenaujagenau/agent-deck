package dev.agentdeck.shared

/**
 * The whole session as one conversation.
 *
 * A session is words and work: what was said, and what the agent did between
 * the sayings. The old reading split those across tabs — chat here, tools
 * there, thoughts somewhere else — so no screen ever showed what actually
 * happened. This fold keeps the words as messages and gathers every run of
 * work between them into one cluster, in order, the way the session was
 * lived. Shared so the phone and the watch tell the same story.
 */
sealed interface TimelineItem {
    /** Someone speaking: the person's instruction or the agent's reply. */
    data class Message(val entry: ConversationEntry) : TimelineItem

    /** A run of work between words — tools, thoughts, warnings — one cluster. */
    data class Activity(val events: List<AgentEvent>) : TimelineItem
}

fun chatTimeline(events: List<AgentEvent>): List<TimelineItem> {
    val sorted = events.sortedBy { it.createdAt }
    val messages = conversationEntries(sorted).associateBy { it.event.id }
    val items = mutableListOf<TimelineItem>()
    val cluster = mutableListOf<AgentEvent>()
    fun flush() {
        if (cluster.isNotEmpty()) {
            items += TimelineItem.Activity(cluster.toList())
            cluster.clear()
        }
    }
    for (event in sorted) {
        val message = messages[event.id]
        when {
            message != null -> {
                flush()
                items += TimelineItem.Message(message)
            }
            isActivity(event) -> cluster += event
        }
    }
    flush()
    return items
}

/**
 * What earns a row in a work cluster: things the agent did. The person's own
 * words never do (they are messages or duplicates of one), and neither does
 * harness plumbing that an adapter published as an event.
 */
private fun isActivity(event: AgentEvent): Boolean {
    if (event.kind == "user") return false
    if (event.kind == "thought" && event.summary == "Received instruction") return false
    if (event.detail.orEmpty().trimStart().startsWith("<task-notification>")) return false
    return event.kind in setOf("tool", "thought", "warning", "error", "output", "question")
}

/**
 * The collapsed cluster's one line: what the work amounted to. Steps first —
 * the honest size of the run — then the tools that dominated it, then how
 * many files it touched. "14 steps · Edit, Bash · 3 files" reads at a
 * glance; the expansion carries the detail.
 */
fun activitySummary(events: List<AgentEvent>): String {
    val steps = "${events.size} ${if (events.size == 1) "step" else "steps"}"
    val tools = events.mapNotNull { it.tool?.takeIf(String::isNotBlank) }
        .groupingBy { it }
        .eachCount()
        .entries
        .sortedByDescending { it.value }
        .take(2)
        .joinToString(", ") { it.key }
    val files = events.mapNotNull { it.path?.takeIf(String::isNotBlank) }.distinct().size
    return listOfNotNull(
        steps,
        tools.takeIf { it.isNotBlank() },
        when {
            files == 0 -> null
            files == 1 -> "1 file"
            else -> "$files files"
        },
    ).joinToString(" · ")
}

/** The event a timeline item leads with — what separators and list keys anchor on. */
val TimelineItem.leadEvent: AgentEvent
    get() = when (this) {
        is TimelineItem.Message -> entry.event
        is TimelineItem.Activity -> events.first()
    }

/** The item's newest event — what "did anything change" comparisons anchor on. */
val TimelineItem.newestEvent: AgentEvent
    get() = when (this) {
        is TimelineItem.Message -> entry.event
        is TimelineItem.Activity -> events.last()
    }
