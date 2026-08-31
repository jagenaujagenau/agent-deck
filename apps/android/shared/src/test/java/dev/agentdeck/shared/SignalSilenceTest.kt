package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SignalSilenceTest {
    private fun agent(state: String, latestEventAt: String) = Agent(
        id = "a1", name = "S", project = "p", model = "m", state = state,
        task = "Using Edit", tokens = 0, costUsd = 0.0,
        lastSeenAt = "2026-08-31T11:50:00Z",
        events = listOf(AgentEvent(id = "e1", kind = "tool", summary = "", createdAt = latestEventAt)),
    )

    private val now = java.time.Instant.parse("2026-08-31T12:00:00Z").toEpochMilli()

    @Test
    fun `a running session mute for minutes says how long`() {
        assertEquals(10L, signalSilenceMinutes(agent("running", "2026-08-31T11:50:00Z"), now))
    }

    @Test
    fun `signal still flowing is not silence`() {
        assertNull(signalSilenceMinutes(agent("running", "2026-08-31T11:58:30Z"), now))
    }

    @Test
    fun `only a running session can be suspiciously quiet`() {
        assertNull(signalSilenceMinutes(agent("idle", "2026-08-31T11:00:00Z"), now))
        assertNull(signalSilenceMinutes(agent("waiting", "2026-08-31T11:00:00Z"), now))
    }

    @Test
    fun `the silent session's card says the silence, not the stale task`() {
        // agentCardActivity uses the wall clock; a decade-old event is silent
        // under any clock this test will ever run on.
        assertEquals(
            true,
            agentCardActivity(agent("running", "2016-08-31T11:00:00Z")).startsWith("No signal for "),
        )
    }
}
