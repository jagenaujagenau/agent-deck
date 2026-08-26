package dev.agentdeck.shared

object ConnectionPolicy {
    fun shouldApply(lastSequence: Long, incomingSequence: Long) = incomingSequence >= lastSequence

    /**
     * How long to wait before trying the stream again.
     *
     * `maxMs` is a parameter because the right ceiling depends on what is
     * doing the waiting. A phone on mains can afford to retry every 16
     * seconds; a watch with a 316 mAh battery retrying an address it cannot
     * reach does that 225 times an hour, waking its radio each time, and the
     * relay from the phone means it learns nothing by trying.
     */
    fun retryDelay(baseMs: Long, failedAttempts: Int, maxMs: Long = 16_000): Long {
        if (failedAttempts <= 0) return baseMs.coerceAtMost(maxMs)
        var delay = baseMs
        repeat((failedAttempts - 1).coerceAtMost(8)) { delay = (delay * 2).coerceAtMost(maxMs) }
        return delay.coerceAtMost(maxMs)
    }

    fun isBlocked(message: String) = message.contains("401") || message.contains("403")
}
