package dev.agentdeck.shared

object ConnectionPolicy {
    fun shouldApply(lastSequence: Long, incomingSequence: Long) = incomingSequence >= lastSequence

    fun retryDelay(baseMs: Long, failedAttempts: Int): Long {
        if (failedAttempts <= 0) return baseMs
        var delay = baseMs
        repeat((failedAttempts - 1).coerceAtMost(8)) { delay = (delay * 2).coerceAtMost(16_000) }
        return delay.coerceAtMost(16_000)
    }

    fun isBlocked(message: String) = message.contains("401") || message.contains("403")
}
