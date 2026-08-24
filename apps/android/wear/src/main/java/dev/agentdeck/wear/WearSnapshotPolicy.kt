package dev.agentdeck.wear

internal object WearSnapshotPolicy {
    const val RELAY_FRESH_MS = 120_000L

    fun shouldApplyRelay(currentSequence: Long, incomingSequence: Long) = incomingSequence >= currentSequence

    fun shouldApplyDirect(currentSequence: Long, incomingSequence: Long, lastRelayAt: Long, now: Long): Boolean {
        val relayIsFresh = lastRelayAt > 0 && now - lastRelayAt <= RELAY_FRESH_MS
        return !relayIsFresh && incomingSequence >= currentSequence
    }
}
