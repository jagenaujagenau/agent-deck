package dev.agentdeck.wear

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearSnapshotPolicyTest {
    @Test
    fun freshPhoneRelayCannotBeOverwrittenByDirectBridgeState() {
        val now = 1_000_000L
        assertFalse(WearSnapshotPolicy.shouldApplyDirect(40, 41, now - 5_000, now))
    }

    @Test
    fun directBridgeBecomesFallbackWhenPhoneRelayIsStale() {
        val now = 1_000_000L
        assertTrue(WearSnapshotPolicy.shouldApplyDirect(40, 41, now - WearSnapshotPolicy.RELAY_FRESH_MS - 1, now))
    }

    @Test
    fun relayMayReplaceEqualSequenceDirectState() {
        assertTrue(WearSnapshotPolicy.shouldApplyRelay(42, 42))
        assertFalse(WearSnapshotPolicy.shouldApplyRelay(43, 42))
    }
}
