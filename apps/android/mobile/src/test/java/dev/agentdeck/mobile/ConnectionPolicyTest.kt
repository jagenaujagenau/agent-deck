package dev.agentdeck.mobile

import dev.agentdeck.shared.ConnectionPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionPolicyTest {
    @Test fun delayedSnapshotsCannotReplaceNewerState() {
        assertFalse(ConnectionPolicy.shouldApply(12, 11))
        assertTrue(ConnectionPolicy.shouldApply(12, 12))
        assertTrue(ConnectionPolicy.shouldApply(12, 13))
    }

    @Test fun retriesAreCappedAndAuthenticationBlocks() {
        assertEquals(1_500, ConnectionPolicy.retryDelay(1_500, 1))
        assertEquals(16_000, ConnectionPolicy.retryDelay(1_500, 20))
        assertTrue(ConnectionPolicy.isBlocked("Event stream returned 401"))
    }

    @Test
    fun `the ceiling is the caller's to choose`() {
        // A watch retrying an address it cannot reach learns nothing by doing
        // it every sixteen seconds, and pays for the radio each time.
        val phone = ConnectionPolicy.retryDelay(1_500, failedAttempts = 20)
        val watch = ConnectionPolicy.retryDelay(1_500, failedAttempts = 20, maxMs = 300_000)
        assertEquals(16_000L, phone)
        assertEquals(300_000L, watch)
    }

    @Test
    fun `a ceiling below the base still caps`() {
        assertEquals(5_000L, ConnectionPolicy.retryDelay(30_000, failedAttempts = 0, maxMs = 5_000))
    }
}
