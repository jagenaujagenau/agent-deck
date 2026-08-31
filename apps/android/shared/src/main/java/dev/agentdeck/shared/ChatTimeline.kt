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

/** A cluster's total diff, summed from every step that carried one. */
data class DiffStat(val added: Int, val removed: Int)

fun diffStat(events: List<AgentEvent>): DiffStat? {
    var added = 0
    var removed = 0
    var any = false
    for (event in events) {
        val diff = event.diff ?: continue
        any = true
        for (line in diff.lineSequence()) {
            when {
                line.startsWith("+++") || line.startsWith("---") -> Unit
                line.startsWith("+") -> added += 1
                line.startsWith("-") -> removed += 1
            }
        }
    }
    return if (any) DiffStat(added, removed) else null
}

/**
 * The collapsed cluster's one line: what the work amounted to, said the way
 * a person would — "Ran 11 commands, edited 2 files", not a step count. The
 * verbs come from what each step actually was; a run of nothing nameable
 * falls back to counting steps.
 */
fun activitySummary(events: List<AgentEvent>): String {
    val commands = events.count { !it.command.isNullOrBlank() || it.tool == "Bash" }
    val paths = events.filter { !it.path.isNullOrBlank() }
    val created = paths.filter { it.tool == "Write" }.map { it.path }.distinct().size
    val read = paths.filter { it.tool == "Read" }.map { it.path }.distinct().size
    val edited = paths.filter { it.tool != "Write" && it.tool != "Read" }.map { it.path }.distinct().size
    val thoughts = events.count { it.kind == "thought" }
    fun files(count: Int) = if (count == 1) "1 file" else "$count files"
    val parts = buildList {
        if (commands > 0) add("ran ${if (commands == 1) "1 command" else "$commands commands"}")
        if (edited > 0) add("edited ${files(edited)}")
        if (created > 0) add("created ${files(created)}")
        if (read > 0) add("read ${files(read)}")
        if (isEmpty() && thoughts > 0) add(if (thoughts == 1) "thought once" else "thought $thoughts times")
    }
    val line = if (parts.isEmpty()) {
        "${events.size} ${if (events.size == 1) "step" else "steps"}"
    } else {
        parts.joinToString(", ")
    }
    return line.replaceFirstChar { it.uppercase() }
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
