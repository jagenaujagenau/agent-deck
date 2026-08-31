package dev.agentdeck.shared

import java.time.Instant

/**
 * The one Request a session is waiting on, if any.
 *
 * A Request is opened by a runtime and resolved exactly once — but "is this
 * session asking me something" was answered five different ways across the
 * two apps, and the answers had already diverged: one phone showed a
 * question card for an ask the runtime had moved past, the other did not;
 * one stacked an approval and a question, the other showed the approval
 * alone. This is that question, asked once.
 *
 * Two rules settle it. An approval outranks a question, because an approval
 * is the one holding a tool call open — the same precedence the bridge's own
 * `pendingBlockFrom` uses. And a question counts as open only when the
 * durable Request says so, or when it is the newest thing the session did:
 * an ask buried under later tool calls is one the runtime answered for
 * itself.
 */
sealed interface OpenRequest {
    val id: String

    data class Approval(val approval: PendingApproval) : OpenRequest {
        override val id: String get() = approval.id
    }

    data class Question(val question: PendingQuestion, val event: AgentEvent?) : OpenRequest {
        override val id: String get() = question.id
    }
}

/** The text an event-derived question asks, preferring its summary over its explanatory detail. */
private fun questionText(event: AgentEvent): String =
    event.summary.takeIf { it.isNotBlank() && !it.equals("Question", true) }
        ?: event.detail?.takeIf { it.isNotBlank() }
        ?: "Agent has a question"

/**
 * What this session is waiting on. Null unless the Agent is waiting, and
 * null for a durable Request whose expiry has passed — an ask nobody can
 * answer any more is not an open Request.
 */
fun openRequest(agent: Agent, now: Instant = Instant.now()): OpenRequest? {
    if (agent.state != "waiting") return null
    fun live(expiresAt: String) = runCatching { Instant.parse(expiresAt).isAfter(now) }.getOrDefault(true)
    agent.pendingApproval?.let { approval ->
        if (live(approval.expiresAt)) return OpenRequest.Approval(approval)
    }
    agent.pendingQuestion?.let { question ->
        if (live(question.expiresAt)) return OpenRequest.Question(question, null)
    }
    // No durable Request: the newest event may still be an unanswered ask.
    val newest = agent.events.maxByOrNull { it.createdAt } ?: return null
    if (newest.kind != "question") return null
    return OpenRequest.Question(
        PendingQuestion(
            id = newest.id,
            question = questionText(newest),
            options = newest.options,
            createdAt = newest.createdAt,
            expiresAt = "",
        ),
        newest,
    )
}
