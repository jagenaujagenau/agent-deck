package dev.agentdeck.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseScrollPolicyTest {
    @Test
    fun userBrowsingHistoryIsNeverPulledToNewResponses() {
        assertFalse(ResponseScrollPolicy.shouldMoveToNewest(initialPositionApplied = true, followNewest = false))
    }

    @Test
    fun openingConversationAndRemainingAtBottomFollowNewest() {
        assertTrue(ResponseScrollPolicy.shouldMoveToNewest(initialPositionApplied = false, followNewest = false))
        assertTrue(ResponseScrollPolicy.shouldMoveToNewest(initialPositionApplied = true, followNewest = true))
    }

    @Test
    fun followModeReturnsOnlyWhenUserReachesBottom() {
        assertFalse(ResponseScrollPolicy.followNewestAfterUserDrag(canScrollForward = true))
        assertTrue(ResponseScrollPolicy.followNewestAfterUserDrag(canScrollForward = false))
    }

    @Test
    fun asyncMessageLayoutGrowthIsCorrectedOnlyWhileFollowing() {
        assertTrue(ResponseScrollPolicy.shouldCorrectLayoutGrowth(true, true, false, true))
        assertFalse(ResponseScrollPolicy.shouldCorrectLayoutGrowth(true, false, false, true))
        assertFalse(ResponseScrollPolicy.shouldCorrectLayoutGrowth(true, true, true, true))
        assertFalse(ResponseScrollPolicy.shouldCorrectLayoutGrowth(true, true, false, false))
    }
}
