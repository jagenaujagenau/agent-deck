package dev.agentdeck.shared

import java.time.Instant

/**
 * When a session is asking for a person, and whether that has been said yet.
 *
 * Shared because both the phone and the watch have to reach the same verdict
 * from the same snapshot. Two devices disagreeing about whether something
 * needs you is worse than either of them being wrong on its own: one buzzes,
 * the other does not, and neither can be trusted afterwards.
 */
object AttentionPolicy {
    enum class Action { Ignore, Cancel, Notify }

    data class Decision(val action: Action, val observedAt: String, val resolved: Boolean, val approvalKey: String?)

    fun approvalKey(agent: Agent): String? {
        val approval = agent.pendingApproval ?: return null
        if (!supportsCapability(agent.capabilities, "approve") || !supportsCapability(agent.capabilities, "reject")) return null
        if (agent.state != "waiting" || runCatching { Instant.parse(approval.expiresAt).isAfter(Instant.now()) }.getOrDefault(false).not()) return null
        return "${agent.id}:${approval.id}"
    }

    /**
     * Which open Request a notification is about. Approvals additionally
     * require the runtime to advertise approve/reject — a notification whose
     * buttons cannot act is worse than none — so this asks `approvalKey`
     * first and only then the shared derivation.
     */
    private fun attentionKey(agent: Agent): String? {
        approvalKey(agent)?.let { return it }
        val open = openRequest(agent) ?: return null
        return if (open is OpenRequest.Question) "${agent.id}:${open.id}" else null
    }

    fun decide(agent: Agent, previousAt: String?, previousResolved: Boolean, previousKey: String?): Decision {
        val observedAt = maxOf(agent.lastSeenAt, agent.events.maxOfOrNull { it.createdAt } ?: agent.lastSeenAt)
        val key = attentionKey(agent)
        if (previousAt != null && observedAt < previousAt) return Decision(Action.Ignore, previousAt, previousResolved, previousKey)
        if (previousAt == observedAt && previousResolved && key != null) {
            return Decision(Action.Ignore, previousAt, previousResolved, previousKey)
        }
        return Decision(
            action = when {
                key == null && !previousResolved -> Action.Cancel
                key == null -> Action.Ignore
                key == previousKey -> Action.Ignore
                else -> Action.Notify
            },
            observedAt = observedAt,
            resolved = key == null,
            approvalKey = key,
        )
    }
}
