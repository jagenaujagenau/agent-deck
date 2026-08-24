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
}
