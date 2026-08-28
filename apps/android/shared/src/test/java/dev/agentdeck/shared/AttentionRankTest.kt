package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionRankTest {
    @Test
    fun `the stuck one is always first`() {
        assertEquals(5, attentionPriority("error", blocked = false, seen = true))
        // A runtime reporting error while also blocked is still first as an error.
        assertEquals(5, attentionPriority("error", blocked = true, seen = false))
        assertEquals(4, attentionPriority("waiting", blocked = true, seen = true))
    }

    @Test
    fun `finished while you weren't looking outranks running`() {
        val doneUnseen = attentionPriority("idle", blocked = false, seen = false)
        val running = attentionPriority("running", blocked = false, seen = true)
        assertEquals(3, doneUnseen)
        assertEquals(2, running)
        assertTrue(doneUnseen > running)
    }

    @Test
    fun `an idle session already read asks for almost nothing`() {
        assertEquals(1, attentionPriority("idle", blocked = false, seen = true))
        assertEquals(0, attentionPriority("offline", blocked = false, seen = false))
        assertEquals(0, attentionPriority("someday-state", blocked = false, seen = false))
    }

    private fun agent(lastSeenAt: String, events: List<AgentEvent> = emptyList(), viewedAt: String? = null) = Agent(
        id = "a", name = "Pi", project = "deck", model = "gpt-5", state = "idle",
        task = "Done", tokens = 0, costUsd = 0.0, lastSeenAt = lastSeenAt, viewedAt = viewedAt, events = events,
    )

    @Test
    fun `latest activity is the newer of heartbeat and events`() {
        val event = AgentEvent("e", "output", "Response", createdAt = "2026-08-24T12:05:00Z")
        assertEquals("2026-08-24T12:05:00Z", latestActivityAt(agent("2026-08-24T12:00:00Z", listOf(event))))
        assertEquals("2026-08-24T12:00:00Z", latestActivityAt(agent("2026-08-24T12:00:00Z")))
    }

    @Test
    fun `a seen mark covers only activity at or before it`() {
        assertTrue(seenCovers("2026-08-24T12:05:00Z", "2026-08-24T12:05:00Z"))
        assertTrue(seenCovers("2026-08-24T12:06:00Z", "2026-08-24T12:05:00Z"))
        assertFalse(seenCovers("2026-08-24T12:04:00Z", "2026-08-24T12:05:00Z"))
        // Never marked is never seen: a brand-new session is "done (unseen)".
        assertFalse(seenCovers(null, "2026-08-24T12:05:00Z"))
    }

    @Test
    fun `a session is seen when this device read it, wherever the bridge stands`() {
        assertTrue(sessionSeen(agent("2026-08-24T12:00:00Z"), localSeenAt = "2026-08-24T12:00:00Z"))
    }

    @Test
    fun `a read on any other surface covers this one through the bridge`() {
        assertTrue(sessionSeen(agent("2026-08-24T12:00:00Z", viewedAt = "2026-08-24T12:01:00Z"), localSeenAt = null))
    }

    @Test
    fun `newer activity re-badges everywhere, whoever read it last`() {
        val workedOnSince = agent("2026-08-24T12:05:00Z", viewedAt = "2026-08-24T12:01:00Z")
        assertFalse(sessionSeen(workedOnSince, localSeenAt = "2026-08-24T12:02:00Z"))
    }

    @Test
    fun `a session nobody read anywhere is unseen`() {
        assertFalse(sessionSeen(agent("2026-08-24T12:00:00Z"), localSeenAt = null))
    }
}
