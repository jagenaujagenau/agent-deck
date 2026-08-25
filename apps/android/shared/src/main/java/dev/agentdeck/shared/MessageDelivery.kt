package dev.agentdeck.shared

/**
 * What actually happens to a message after the bridge accepts it.
 *
 * Accepting a message and delivering it are different things. A hook cannot
 * type into a running session, so a message is handed over at a turn boundary:
 * the Stop hook at the end of a turn, or the next prompt the person submits in
 * the terminal. A session that is not running a turn has neither until someone
 * goes back to it, and saying nothing in that case reads as the message having
 * been sent.
 */
enum class MessageDelivery {
    /** A turn is running; it will be handed over when that turn ends. */
    AtEndOfTurn,

    /** Nothing is running, so it waits for whatever the session does next. */
    WhenSessionResumes,

    /** The session has stopped reporting; nothing is listening for it. */
    Unreachable,
}

fun deliveryFor(agentState: String): MessageDelivery = when (agentState) {
    "running" -> MessageDelivery.AtEndOfTurn
    "offline" -> MessageDelivery.Unreachable
    // idle, waiting, paused and anything a newer runtime reports: no turn is in
    // flight, so there is no boundary to deliver at until the session moves.
    else -> MessageDelivery.WhenSessionResumes
}

/** How that reads on the composer, or null when it needs no explanation. */
fun deliveryNotice(agentState: String): String? = when (deliveryFor(agentState)) {
    // A turn is running and will end on its own, which is the normal case and
    // needs no commentary.
    MessageDelivery.AtEndOfTurn -> null
    // Short enough to sit on one line above the composer. The old wording
    // explained the mechanism over two lines every time someone opened a resting
    // session, which is most of the time.
    MessageDelivery.WhenSessionResumes -> "Queued · delivers at the next turn"
    MessageDelivery.Unreachable -> "Queued · session is offline"
}
