package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.attentionPriority
import dev.agentdeck.shared.sessionSeen
import java.time.Duration
import java.time.Instant

internal enum class HomeAgentState(
    val label: String,
    val sectionLabel: String,
    val attention: Boolean = false,
    val compact: Boolean = false,
) {
    ApprovalRequired("Approval required", "APPROVALS", attention = true),
    Question("Question", "QUESTIONS", attention = true),
    InputRequired("Input required", "INPUT REQUIRED", attention = true),
    Failed("Failed", "FAILED", attention = true),

    // "Finished while you weren't looking", ranked above Running because a
    // result nobody has collected is worth more than progress that needs
    // nothing. This is the attention-adjacent seat: not amber - nothing is
    // asking for a person - but above everything that is merely fine.
    Done("Done", "DONE · UNSEEN"),
    Running("Running", "RUNNING"),
    Paused("Paused", "PAUSED", compact = true),
    RecentlyCompleted("Completed", "RECENTLY COMPLETED", compact = true),
    History("History", "HISTORY", compact = true),
}

internal enum class HomeFilter(val label: String) { Now("Now"), Attention("Needs you"), History("History") }

internal fun homeAgentState(
    agent: Agent,
    archived: Boolean = false,
    now: Instant = Instant.now(),
    seen: Boolean = true,
): HomeAgentState {
    if (archived) return HomeAgentState.History
    return when {
        agent.state == "waiting" && agent.pendingApproval != null -> HomeAgentState.ApprovalRequired
        agent.state == "waiting" && (agent.pendingQuestion != null || agent.events.any { it.kind == "question" }) -> HomeAgentState.Question
        agent.state == "waiting" -> HomeAgentState.InputRequired
        agent.state == "error" -> HomeAgentState.Failed
        agent.state == "running" -> HomeAgentState.Running
        agent.state == "paused" -> HomeAgentState.Paused
        // Unseen wins over the ten-minute clock: an idle session stays "done"
        // until this phone has shown it, however long ago it went idle.
        agent.state == "idle" && !seen -> HomeAgentState.Done
        agent.state == "idle" && runCatching {
            Duration.between(Instant.parse(agent.lastSeenAt), now).toMinutes() < 10
        }.getOrDefault(false) -> HomeAgentState.RecentlyCompleted
        else -> HomeAgentState.History
    }
}

internal fun HomeFilter.includes(state: HomeAgentState) = when (this) {
    HomeFilter.Now -> state != HomeAgentState.History
    HomeFilter.Attention -> state.attention
    HomeFilter.History -> state == HomeAgentState.History
}

/** Whether anyone has shown everything the session has done - this phone, or any surface via the bridge. */
internal fun agentSeen(agent: Agent, seenMarks: Map<String, String>): Boolean =
    sessionSeen(agent, seenMarks[agent.id])

/** Mutable heartbeats and activity text never affect ordering within a presentation state. */
internal fun homeAgentOrder(
    agents: List<Agent>,
    archivedKeys: Set<String>,
    now: Instant = Instant.now(),
    seenMarks: Map<String, String> = emptyMap(),
): List<Agent> = agents.sortedWith(
    compareBy<Agent> { homeAgentState(it, agentArchiveKey(it) in archivedKeys, now, agentSeen(it, seenMarks)).ordinal }
        // Sections carry the coarse order; within one, the shared ranking
        // breaks whatever ties the sections leave (unseen-done over seen-idle
        // when a section mixes them, as History can).
        .thenByDescending { attentionPriority(it.state, it.state == "waiting", agentSeen(it, seenMarks)) }
        .thenBy { it.project.lowercase() }
        .thenBy { it.id },
)
