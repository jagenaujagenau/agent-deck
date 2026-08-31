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
/** The tools that look things up rather than change them. A Grep hit carries a path, but nothing was edited. */
private val searchTools = setOf("Grep", "Glob", "WebSearch", "WebFetch")

fun activitySummary(events: List<AgentEvent>): String {
    val commands = events.count { !it.command.isNullOrBlank() || it.tool == "Bash" }
    val searches = events.count { it.tool in searchTools }
    val paths = events.filter { !it.path.isNullOrBlank() && it.tool !in searchTools }
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
        if (searches > 0) add("searched ${if (searches == 1) "once" else "$searches times"}")
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

/**
 * One entry of the conversation map: an exchange, said small.
 *
 * A phone chat holding two hundred turns has no scrollbar worth the name.
 * The map is the table of contents a long conversation earns — one row per
 * thing the person asked, with how the agent left it — and each row knows
 * the event the timeline can scroll to.
 */
data class ConversationMarker(
    /** The user message's event id — the timeline item to scroll to. */
    val id: String,
    val prompt: String,
    /** How the exchange ended: the last reply before the next ask, if any. */
    val reply: String?,
    val at: String,
)

fun conversationMarkers(events: List<AgentEvent>): List<ConversationMarker> {
    val markers = mutableListOf<ConversationMarker>()
    var prompt: ConversationEntry? = null
    var reply: ConversationEntry? = null
    fun flush() {
        prompt?.let { asked ->
            markers += ConversationMarker(
                id = asked.event.id,
                prompt = markerPreview(asked.content),
                reply = reply?.let { markerPreview(it.content) },
                at = asked.event.createdAt,
            )
        }
        prompt = null
        reply = null
    }
    for (entry in conversationEntries(events)) {
        if (entry.role == ConversationRole.User) {
            flush()
            prompt = entry
        } else if (prompt != null) {
            reply = entry
        }
    }
    flush()
    return markers
}

/**
 * A message reduced to one plain line: markdown dressing stripped, code
 * blocks named rather than quoted, clipped at a word.
 */
fun markerPreview(text: String, limit: Int = 96): String {
    val line = text
        .replace(Regex("```[\\s\\S]*?(```|$)"), " code ")
        .replace(Regex("`([^`]*)`"), "$1")
        .replace(Regex("!?\\[([^\\]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("(?m)^\\s{0,3}(#{1,6}|>|[-+*]|\\d+[.)])\\s+"), "")
        .replace(Regex("[*_]{1,3}"), "")
        .replace(Regex("\\s+"), " ")
        .trim()
    if (line.length <= limit) return line
    val clipped = line.take(limit - 1).trimEnd()
    return clipped.substringBeforeLast(' ', clipped) + "…"
}

/** How many steps of a run failed — worn on the cluster header so triage needs no expansion. */
fun failedSteps(events: List<AgentEvent>): Int = events.count { it.kind == "error" }

/**
 * A cluster's steps, partitioned into who did them.
 *
 * A session that farms work out mixes its subagents' tool calls into its
 * own, and a flat list of forty steps hides that three belonged to a
 * search agent and thirty to a build agent. Consecutive runs of one
 * subagent's work become one segment, titled by what that run was asked to
 * do, so the steps sheet can fold each helper to a single line the way the
 * cluster itself folds into the conversation.
 */
data class ActivitySegment(
    /** Null for the session's own work. */
    val subagentId: String?,
    val title: String,
    val events: List<AgentEvent>,
)

fun activitySegments(events: List<AgentEvent>): List<ActivitySegment> {
    val segments = mutableListOf<ActivitySegment>()
    for (event in events) {
        val last = segments.lastOrNull()
        if (last != null && last.subagentId == event.subagentId) {
            segments[segments.size - 1] = last.copy(events = last.events + event)
        } else {
            segments += ActivitySegment(
                subagentId = event.subagentId,
                title = event.subagentName ?: event.subagentType ?: "Subagent",
                events = listOf(event),
            )
        }
    }
    return segments
}

/** Whether a tool looks things up rather than changes them. */
fun isSearchTool(tool: String?): Boolean = tool in searchTools

/**
 * When the person last instructed — the boundary of the current pass. The
 * changes receipt leads with what this pass touched, because mid-conversation
 * the question is "what did it just do", not "what has this session ever
 * done"; a long-lived session's grand total buries the answer.
 */
fun latestInstructionAt(events: List<AgentEvent>): String? =
    conversationEntries(events).lastOrNull { it.role == ConversationRole.User }?.event?.createdAt

/**
 * Where the news begins: the first timeline item this reader has not seen,
 * for the "New" divider a returning reader lands on. Null when there is no
 * mark to compare against, nothing is new, or everything is — a divider
 * above the whole conversation marks nothing.
 */
fun firstUnseenIndex(items: List<TimelineItem>, seenUpTo: String?): Int? {
    if (seenUpTo.isNullOrBlank()) return null
    val index = items.indexOfFirst { it.newestEvent.createdAt > seenUpTo }
    return if (index <= 0) null else index
}
