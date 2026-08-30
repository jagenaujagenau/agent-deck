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
        viewedAt: String? = null,
    ) = Agent(
        id = id, name = "Pi", project = project, model = "gpt-5",
        state = state, task = "Working", tokens = 0, costUsd = 0.0,
        lastSeenAt = lastSeenAt, viewedAt = viewedAt, events = events, pendingApproval = approval,
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
        val deck = homeDeck(
            listOf(
                agent("done", "idle"),
                agent("run-b", "running", project = "b"),
                agent("input", "waiting", project = "z"),
                agent("run-a", "running", project = "a"),
            ),
            archivedKeys = emptySet(),
            now = now,
            // The idle session has been read, so it asks for nothing and sorts last.
            seenMarks = mapOf("done" to "2026-08-24T11:59:00Z"),
        )
        assertEquals(listOf("input", "run-a", "run-b", "done"), deck.cards.map { it.agent.id })
    }

    @Test
    fun finishedWhileYouWerentLookingOutranksRunning() {
        // No seen mark at all: this phone has never shown the session.
        assertEquals(
            HomeAgentState.Done,
            homeAgentState(agent("fresh", "idle"), now = now, seen = false),
        )
        // Unseen wins over the ten-minute decay into History.
        assertEquals(
            HomeAgentState.Done,
            homeAgentState(agent("stale", "idle", lastSeenAt = "2026-08-24T10:00:00Z"), now = now, seen = false),
        )
        val deck = homeDeck(
            listOf(agent("run", "running"), agent("fresh", "idle")),
            archivedKeys = emptySet(),
            seenMarks = emptyMap(),
            now = now,
        )
        assertEquals(listOf("fresh", "run"), deck.cards.map { it.agent.id })
    }

    @Test
    fun aReadOnAnotherSurfaceClearsDoneHereToo() {
        // No local mark at all - the bridge's viewedAt alone covers the session,
        // so it sorts with the read, not above the running one.
        val deck = homeDeck(
            listOf(agent("run", "running"), agent("done", "idle", viewedAt = "2026-08-24T11:59:00Z")),
            archivedKeys = emptySet(),
            seenMarks = emptyMap(),
            now = now,
        )
        assertEquals(listOf("run", "done"), deck.cards.map { it.agent.id })
        // But a session that worked on after the read is unseen again.
        assertFalse(agentSeen(agent("done", "idle", viewedAt = "2026-08-24T11:58:00Z"), emptyMap()))
    }

    @Test
    fun doneIsNotAnAttentionStateAndStaysOutOfNeedsYou() {
        assertTrue(HomeFilter.Now.includes(HomeAgentState.Done))
        assertFalse(HomeFilter.Attention.includes(HomeAgentState.Done))
    }
}
