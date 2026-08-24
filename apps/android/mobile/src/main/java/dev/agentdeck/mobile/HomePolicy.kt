package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
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
): HomeAgentState {
    if (archived) return HomeAgentState.History
    return when {
        agent.state == "waiting" && agent.pendingApproval != null -> HomeAgentState.ApprovalRequired
        agent.state == "waiting" && agent.events.any { it.kind == "question" } -> HomeAgentState.Question
        agent.state == "waiting" -> HomeAgentState.InputRequired
        agent.state == "error" -> HomeAgentState.Failed
        agent.state == "running" -> HomeAgentState.Running
        agent.state == "paused" -> HomeAgentState.Paused
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

/** Mutable heartbeats and activity text never affect ordering within a presentation state. */
internal fun homeAgentOrder(
    agents: List<Agent>,
    archivedKeys: Set<String>,
    now: Instant = Instant.now(),
): List<Agent> = agents.sortedWith(
    compareBy<Agent> { homeAgentState(it, agentArchiveKey(it) in archivedKeys, now).ordinal }
        .thenBy { it.project.lowercase() }
        .thenBy { it.id },
)
