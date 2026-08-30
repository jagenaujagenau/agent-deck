package dev.agentdeck.shared

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertArmingTest {
    private fun agent(viewedAt: String? = null) = Agent(
        id = "a1",
        name = "Claude",
        project = "deck",
        model = "test",
        state = "waiting",
        task = "Approval: Bash",
        tokens = 0,
        costUsd = 0.0,
        lastSeenAt = "2026-08-30T12:00:00.000Z",
        viewedAt = viewedAt,
    )

    @Test
    fun `the first ask always buzzes`() {
        assertTrue(AlertArming.armed(agent(), localSeenAt = null, lastAlertAt = null))
    }

    @Test
    fun `an unanswered buzz disarms the next one`() {
        assertFalse(
            AlertArming.armed(agent(), localSeenAt = null, lastAlertAt = "2026-08-30T12:00:00.000Z"),
        )
    }

    @Test
    fun `viewing the session on this device re-arms it`() {
        assertTrue(
            AlertArming.armed(
                agent(),
                localSeenAt = "2026-08-30T12:05:00.000Z",
                lastAlertAt = "2026-08-30T12:00:00.000Z",
            ),
        )
    }

    @Test
    fun `viewing it anywhere re-arms it, through the bridge's mark`() {
        assertTrue(
            AlertArming.armed(
                agent(viewedAt = "2026-08-30T12:05:00.000Z"),
                localSeenAt = null,
                lastAlertAt = "2026-08-30T12:00:00.000Z",
            ),
        )
    }

    @Test
    fun `a view older than the buzz does not re-arm`() {
        // The person looked before this alert fired; they have not seen what
        // it was about.
        assertFalse(
            AlertArming.armed(
                agent(viewedAt = "2026-08-30T11:55:00.000Z"),
                localSeenAt = "2026-08-30T11:50:00.000Z",
                lastAlertAt = "2026-08-30T12:00:00.000Z",
            ),
        )
    }
}
