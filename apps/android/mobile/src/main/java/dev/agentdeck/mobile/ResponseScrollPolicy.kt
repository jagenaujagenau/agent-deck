package dev.agentdeck.mobile

internal object ResponseScrollPolicy {
    fun shouldMoveToNewest(initialPositionApplied: Boolean, followNewest: Boolean): Boolean =
        !initialPositionApplied || followNewest

    fun followNewestAfterUserDrag(canScrollForward: Boolean): Boolean = !canScrollForward

    fun shouldCorrectLayoutGrowth(initialPositionApplied: Boolean, followNewest: Boolean, userDragging: Boolean, canScrollForward: Boolean): Boolean =
        initialPositionApplied && followNewest && !userDragging && canScrollForward
}
