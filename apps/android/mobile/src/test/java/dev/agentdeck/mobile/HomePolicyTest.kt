package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.PendingApproval
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomePolicyTest {
    private val now = Instant.parse("2026-08-24T12:00:00Z")
    private fun agent(
        id: String,
        state: String,
        project: String = "deck",
        lastSeenAt: String = "2026-08-24T11:59:00Z",
        events: List<AgentEvent> = emptyList(),
        approval: PendingApproval? = null,
    ) = Agent(
        id = id, name = "Pi", project = project, model = "gpt-5",
        state = state, task = "Working", tokens = 0, costUsd = 0.0,
        lastSeenAt = lastSeenAt, events = events, pendingApproval = approval,
    )

    @Test
    fun waitingExplainsTheConcreteReason() {
        val approval = PendingApproval("a", "bash", "Run command", "2026-08-24T11:59:00Z", "2026-08-24T12:10:00Z")
        val question = AgentEvent("q", "question", "Choose", "Which?", "2026-08-24T11:59:00Z")
        assertEquals(HomeAgentState.ApprovalRequired, homeAgentState(agent("a", "waiting", approval = approval), now = now))
        assertEquals(HomeAgentState.Question, homeAgentState(agent("q", "waiting", events = listOf(question)), now = now))
        assertEquals(HomeAgentState.InputRequired, homeAgentState(agent("i", "waiting"), now = now))
    }

    @Test
    fun completionDecaysIntoHistoryAndArchiveAlwaysWins() {
        assertEquals(HomeAgentState.RecentlyCompleted, homeAgentState(agent("new", "idle"), now = now))
        assertEquals(HomeAgentState.History, homeAgentState(agent("old", "idle", lastSeenAt = "2026-08-24T11:30:00Z"), now = now))
        assertEquals(HomeAgentState.History, homeAgentState(agent("run", "running"), archived = true, now = now))
    }

    @Test
    fun filtersHaveNonOverlappingJobs() {
        assertTrue(HomeFilter.Now.includes(HomeAgentState.Running))
        assertTrue(HomeFilter.Attention.includes(HomeAgentState.Question))
        assertFalse(HomeFilter.Attention.includes(HomeAgentState.Paused))
        assertTrue(HomeFilter.History.includes(HomeAgentState.History))
        assertFalse(HomeFilter.Now.includes(HomeAgentState.History))
    }

    @Test
    fun orderingIsStateFirstThenStableProjectAndIdentity() {
        val ordered = homeAgentOrder(
            listOf(
                agent("done", "idle"),
                agent("run-b", "running", project = "b"),
                agent("input", "waiting", project = "z"),
                agent("run-a", "running", project = "a"),
            ),
            archivedKeys = emptySet(),
            now = now,
        )
        assertEquals(listOf("input", "run-a", "run-b", "done"), ordered.map { it.id })
    }
}
