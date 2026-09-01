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
        when (openRequest(agent)) {
            is OpenRequest.Approval -> return "Review required"
            is OpenRequest.Question -> return "Awaiting your answer"
            null -> Unit
        }
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

/**
 * The headline a surface leads with: what this session is actually about,
 * which is not always its `task`.
 *
 * Lived in the phone's UI file as a private function, unreachable from any
 * test, while its Swift twin lived in a view file outside the policy package
 * — so the two drifted in three places (a blank-detail instruction, a
 * whitespace-only question, and iOS alone honouring `objective`). Shared and
 * corpus-pinned now.
 */
fun usefulTask(agent: Agent): String = stripMarkdownForPreview(rawUsefulTask(agent))

/**
 * The same headline before its Markdown is taken off. An approval detail, a
 * question, an instruction and a last response are all agent-written prose,
 * and every surface that shows this shows one clipped line of it.
 */
private fun rawUsefulTask(agent: Agent): String {
    val newest = { kind: String, predicate: (AgentEvent) -> Boolean ->
        agent.events.filter { it.kind == kind && predicate(it) }.maxByOrNull { it.createdAt }
    }
    when (agent.state) {
        "waiting" -> {
            // No "Approval · " or "Question · " prefix: the status the surface
            // already shows says which of the two this is, and the prefix cost
            // a third of the line that had the detail in it.
            agent.pendingApproval?.let { return it.detail }
            agent.pendingQuestion?.let { return it.question.takeIf(String::isNotBlank) ?: "Agent has a question" }
            newest("question") { true }?.let { question ->
                // The summary is the question; the detail is the note
                // explaining it. Reading the detail put "Stripe retries are
                // idempotent by key" on the card and hid "Which payment
                // provider should the retry path use?" — the only part anyone
                // can act on.
                question.summary.takeIf { it.isNotBlank() && !it.equals("Question", true) }?.let { return it }
                question.detail?.takeIf { it.isNotBlank() }?.let { return it }
                return "Agent has a question"
            }
            return agent.task
        }
        "running", "paused" -> {
            agent.objective?.takeIf { it.isNotBlank() }?.let { return it }
            // Blank-detail reports are skipped rather than accepted and
            // rejected: an instruction that says nothing is not the newest
            // instruction, it is noise in front of one.
            newest("thought") { it.summary == "Received instruction" && !it.detail.isNullOrBlank() }
                ?.detail?.let { return it }
            // Falling back to the last thing a person actually asked for.
            // Without it the headline restated the activity line below it
            // verbatim — "Edit finished · continuing" over "Edit finished".
            newest("user") { !it.detail.isNullOrBlank() }?.detail?.let { return it }
        }
        "offline" -> return lastResponse(agent)?.let { "Last response · $it" } ?: "Session ended"
        "idle" -> {
            if (agent.task.lowercase() in setOf("done", "turn completed", "ready for an instruction")) {
                return lastResponse(agent)?.let { "Last response · $it" } ?: "Turn completed"
            }
        }
    }
    if (agent.task.endsWith(" completed")) return "${agent.task.removeSuffix(" completed")} finished · continuing"
    if (agent.task.startsWith("Using ")) return "Running ${agent.task.removePrefix("Using ")}"
    return agent.task
}

private fun lastResponse(agent: Agent): String? =
    agent.events
        .filter { it.kind == "output" && it.summary == "Response" }
        .maxByOrNull { it.createdAt }
        ?.detail
        ?.trim()
        ?.takeIf { it.isNotBlank() }

/**
 * `Claude · orbital-api · 4f2a` ends in a short session hash. Kept as a
 * suffix on a chat's name so two sessions in one project are told apart.
 */
fun sessionSuffix(agent: Agent): String {
    val suffix = agent.name.substringAfterLast('·', "").trim()
    return if (suffix.matches(Regex("[0-9a-fA-F]{4}"))) " · $suffix" else ""
}

/**
 * The chat's name. The project is the conversation a person recognises; the
 * short session suffix keeps two sessions in one project tellable apart, and
 * the harness only names the row when the session has no project at all.
 */
fun chatTitle(agent: Agent): String =
    agent.project.ifBlank { Harnesses.of(agent).label } + sessionSuffix(agent)
