package dev.agentdeck.shared

/**
 * One subagent's run, assembled from the events it produced.
 *
 * Derived rather than reported: the bridge stores no subagent record, only
 * events that now carry the id and type of whichever subagent made them. That
 * is enough to reconstruct a run, and it means nothing has to be kept in sync
 * with a second source of truth.
 */
data class SubagentRun(
    val id: String,
    /** The runtime's own word for it - "general-purpose", "Explore". */
    val type: String,
    /**
     * What the run was asked to do - "Fix lint in apps/server". The spawn
     * event carries it; sessions observed by an older adapter have none.
     */
    val name: String? = null,
    val startedAt: String,
    val lastAt: String,
    /** What it is doing, or the last thing it did. */
    val activity: String,
    val eventCount: Int,
    val finished: Boolean,
) {
    /**
     * What a row or lens header calls this run. Five parallel
     * "general-purpose" runs are told apart by their errand, not their kind.
     */
    val title: String get() = name ?: type
}

/** The hook publishes a subagent's last breath under this summary. */
private fun isCompletion(event: AgentEvent) =
    event.tool == "Task" && event.summary.endsWith("subagent finished", ignoreCase = true)

/**
 * Every subagent that has produced an event in this session, oldest first.
 *
 * Ordered by when each started rather than by recency, so a list read twice in
 * a row names them in the same order - a session with three of them running is
 * exactly when a jumping list is least welcome.
 */
fun subagentRuns(events: List<AgentEvent>): List<SubagentRun> {
    val byId = LinkedHashMap<String, MutableList<AgentEvent>>()
    for (event in events) {
        val id = event.subagentId ?: continue
        byId.getOrPut(id) { mutableListOf() }.add(event)
    }
    return byId.map { (id, own) ->
        val ordered = own.sortedBy { it.createdAt }
        val last = ordered.last()
        SubagentRun(
            id = id,
            type = ordered.firstNotNullOfOrNull { it.subagentType }?.takeIf { it.isNotBlank() }
                ?: "Subagent",
            name = ordered.firstNotNullOfOrNull { it.subagentName?.takeIf(String::isNotBlank) },
            startedAt = ordered.first().createdAt,
            lastAt = last.createdAt,
            // A completion event's summary is "<type> subagent finished", which
            // says nothing a finished run does not already say. The work it did
            // last is the more useful line.
            activity = ordered.lastOrNull { !isCompletion(it) }?.summary ?: last.summary,
            eventCount = ordered.size,
            finished = ordered.any(::isCompletion),
        )
    }.sortedBy { it.startedAt }
}

/** What the picker can narrow the run list to. */
enum class SubagentFilter { All, Running, Done }

/**
 * Where the picker opens: on the running work when there is any, on everything
 * otherwise. Mid-flight the reason to open the sheet is almost always a live
 * lens; once everything has finished, it is review.
 */
fun defaultSubagentFilter(runs: List<SubagentRun>): SubagentFilter =
    if (runs.any { !it.finished }) SubagentFilter.Running else SubagentFilter.All

/**
 * The runs a filter shows, grouped but never reshuffled: running above done,
 * each group in the stable started order `subagentRuns` promises — a row only
 * moves when its status actually changes. The selected run is always shown,
 * whatever the filter: a picker must not hide the thing it has a check on.
 */
fun filteredSubagentRuns(
    runs: List<SubagentRun>,
    filter: SubagentFilter,
    selectedId: String? = null,
): List<SubagentRun> {
    val visible = runs.filter { run ->
        run.id == selectedId ||
            when (filter) {
                SubagentFilter.All -> true
                SubagentFilter.Running -> !run.finished
                SubagentFilter.Done -> run.finished
            }
    }
    return visible.filter { !it.finished } + visible.filter { it.finished }
}

/**
 * The session as one subagent saw it.
 *
 * Its own events only - not the parent's, and not a sibling's. Passing the
 * result to the same views the whole session uses is what lets a subagent be
 * read with the tabs already built rather than a second screen.
 */
fun eventsOfSubagent(events: List<AgentEvent>, subagentId: String): List<AgentEvent> =
    events.filter { it.subagentId == subagentId }
