package dev.agentdeck.wear

import dev.agentdeck.shared.Agent
import org.junit.Assert.assertEquals
import org.junit.Test

class WearStatePagesTest {
    private fun agent(id: String, state: String) = Agent(
        id = id,
        name = id,
        project = "deck",
        model = "model",
        state = state,
        task = "task",
        tokens = 0,
        costUsd = 0.0,
        lastSeenAt = "2026-08-24T10:00:00Z",
    )

    @Test
    fun eachAgentAppearsOnItsOperationalStatePage() {
        val agents = listOf(
            agent("running", "running"),
            agent("waiting", "waiting"),
            agent("error", "error"),
            agent("paused", "paused"),
            agent("idle", "idle"),
            agent("offline", "offline"),
        )

        assertEquals(listOf("running"), agentsForPage(agents, WearStatePage.Running).map { it.id })
        assertEquals(listOf("waiting", "error"), agentsForPage(agents, WearStatePage.NeedsYou).map { it.id })
        assertEquals(listOf("paused"), agentsForPage(agents, WearStatePage.Paused).map { it.id })
        assertEquals(listOf("idle"), agentsForPage(agents, WearStatePage.Idle).map { it.id })
    }
}
