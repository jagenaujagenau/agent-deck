package dev.agentdeck.shared

/**
 * Whether an attention alert may make noise, or must arrive quietly.
 *
 * The first ask buzzes. While that buzz sits unanswered, every further ask
 * from the same session arrives quietly — the shade stays current, with the
 * newest request and its actions, but the pocket and the wrist stay calm: a
 * session flapping through prompts while its person is busy must not teach
 * them to ignore the buzz. Viewing the session re-arms it, because a person
 * who has looked and moved on is one who asked to be told about the next
 * thing. Dismissing the notification is not viewing — a swipe says "not
 * now", never "tell me again, louder".
 *
 * `lastAlertAt` is the session's activity timestamp at the moment the last
 * audible alert fired — snapshot clock, the same clock every seen mark is on,
 * so no device clock ever enters the comparison.
 */
object AlertArming {
    fun armed(agent: Agent, localSeenAt: String?, lastAlertAt: String?): Boolean =
        lastAlertAt == null ||
            seenCovers(localSeenAt, lastAlertAt) ||
            seenCovers(agent.viewedAt, lastAlertAt)
}
