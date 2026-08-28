package dev.agentdeck.wear

import dev.agentdeck.shared.Agent
import org.junit.Assert.assertEquals
import org.junit.Test

class WearStatePagesTest {
    private fun agent(id: String, state: String, project: String = "deck", lastSeenAt: String = "2026-08-24T10:00:00Z", viewedAt: String? = null) = Agent(
        id = id,
        name = id,
        project = project,
        model = "model",
        state = state,
        task = "task",
        tokens = 0,
        costUsd = 0.0,
        lastSeenAt = lastSeenAt,
        viewedAt = viewedAt,
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
        // The stuck one is always first: an error outranks a session merely waiting.
        assertEquals(listOf("error", "waiting"), agentsForPage(agents, WearStatePage.NeedsYou).map { it.id })
        assertEquals(listOf("paused"), agentsForPage(agents, WearStatePage.Paused).map { it.id })
        assertEquals(listOf("idle"), agentsForPage(agents, WearStatePage.Idle).map { it.id })
    }

    @Test
    fun unseenDoneFloatsAboveWhatThisWristHasAlreadyRead() {
        val agents = listOf(
            agent("read", "idle"),
            agent("unread", "idle"),
        )
        val ordered = agentsForPage(
            agents,
            WearStatePage.Idle,
            seenMarks = mapOf("read" to "2026-08-24T10:00:00Z"),
        )
        assertEquals(listOf("unread", "read"), ordered.map { it.id })
    }

    @Test
    fun aReadOnAnotherSurfaceQuietsThisWristToo() {
        // The bridge's viewedAt covers "read" with no local mark at all.
        val agents = listOf(
            agent("read", "idle", viewedAt = "2026-08-24T10:00:00Z"),
            agent("unread", "idle"),
        )
        assertEquals(listOf("unread", "read"), agentsForPage(agents, WearStatePage.Idle).map { it.id })
    }
}
