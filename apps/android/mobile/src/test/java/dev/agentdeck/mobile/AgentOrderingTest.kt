package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentOrderingTest {
    private fun agent(id: String, state: String, lastSeenAt: String, project: String = "deck") = Agent(
        id = id, name = "Claude", project = project, model = "claude", state = state,
        task = "Working", tokens = 0, costUsd = 0.0, lastSeenAt = lastSeenAt,
    )

    @Test
    fun heartbeatsDoNotReorderCardsWithinTheSameState() {
        val before = stableAgentOrder(listOf(
            agent("a", "running", "2026-08-24T10:00:00Z"),
            agent("b", "running", "2026-08-24T10:01:00Z"),
        )).map { it.id }
        val after = stableAgentOrder(listOf(
            agent("a", "running", "2026-08-24T10:02:00Z"),
            agent("b", "running", "2026-08-24T10:01:00Z"),
        )).map { it.id }
        assertEquals(before, after)
    }

    @Test
    fun onlyOperationalUrgencyChangesOrder() {
        val ordered = stableAgentOrder(listOf(
            agent("idle", "idle", "2026-08-24T10:03:00Z"),
            agent("run", "running", "2026-08-24T10:01:00Z"),
            agent("wait", "waiting", "2026-08-24T10:00:00Z"),
        ))
        assertEquals(listOf("wait", "run", "idle"), ordered.map { it.id })
    }
}
