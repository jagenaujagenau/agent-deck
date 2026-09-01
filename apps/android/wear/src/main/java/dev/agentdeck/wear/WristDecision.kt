package dev.agentdeck.wear

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.OpenRequest
import dev.agentdeck.shared.PendingApproval
import dev.agentdeck.shared.openRequest
import java.time.Instant

/**
 * What this watch can offer to decide, right now.
 *
 * Whether a session is asking anything is [openRequest]'s answer — the same
 * one both phones use. This is only the part that is true of a wrist: a
 * question with no preset options cannot be answered by tapping, so the watch
 * says where it can be answered instead of showing buttons that are not there.
 *
 * The watch used to derive the whole thing itself, and had drifted in three
 * ways: it read only its events, so a durable Request with no matching event
 * was invisible here; it took the newest *question* rather than the newest
 * event, so an ask the runtime had already moved past still offered buttons;
 * and it never checked expiry, so it offered them for an ask nobody could
 * answer any more.
 */
internal sealed interface WristDecision {
    data class Approve(val approval: PendingApproval) : WristDecision

    /** A question with options, and the event the answer is sent against. */
    data class Answer(val event: AgentEvent) : WristDecision

    /** Waiting on something this screen cannot take: free text, or a host prompt. */
    data object Elsewhere : WristDecision

    /** Nothing is being asked. */
    data object None : WristDecision
}

internal fun wristDecision(agent: Agent, now: Instant = Instant.now()): WristDecision =
    when (val open = openRequest(agent, now)) {
        is OpenRequest.Approval -> WristDecision.Approve(open.approval)
        is OpenRequest.Question -> {
            // The durable Request names its own event id; an event-derived one
            // carries the event itself. Either way the buttons answer against
            // the event the runtime is parked on.
            val event = open.event ?: agent.events.filter { it.id == open.question.id }.maxByOrNull { it.createdAt }
            if (event != null && event.options.isNotEmpty()) WristDecision.Answer(event) else WristDecision.Elsewhere
        }
        null -> if (agent.state == "waiting") WristDecision.Elsewhere else WristDecision.None
    }
