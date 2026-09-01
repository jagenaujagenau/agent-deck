package dev.agentdeck.wear

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.PendingApproval
import dev.agentdeck.shared.PendingQuestion
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the watch offers to decide.
 *
 * Every case here was a live divergence: the watch derived "is this session
 * asking me something" for itself, and its answer differed from both phones'.
 */
class WristDecisionTest {
    private val now = Instant.parse("2026-09-01T12:00:00Z")
    private val soon = "2026-09-01T12:10:00Z"
    private val past = "2026-09-01T11:00:00Z"

    private fun agent(
        state: String = "waiting",
        events: List<AgentEvent> = emptyList(),
        approval: PendingApproval? = null,
        question: PendingQuestion? = null,
    ) = Agent(
        id = "a1",
        name = "Claude · deck · 27d9",
        project = "deck",
        model = "claude",
        state = state,
        task = "",
        tokens = 0,
        costUsd = 0.0,
        lastSeenAt = "2026-09-01T11:59:00Z",
        events = events,
        pendingApproval = approval,
        pendingQuestion = question,
    )

    private fun question(id: String, at: String, options: List<String> = listOf("A", "B")) =
        AgentEvent(id = id, kind = "question", summary = "Which one?", createdAt = at, options = options)

    @Test
    fun `an approval is offered`() {
        val decision = wristDecision(agent(approval = PendingApproval("r1", "Bash", "rm -rf", past, soon)), now)
        assertEquals("Bash", (decision as WristDecision.Approve).approval.tool)
    }

    @Test
    fun `an expired approval offers nothing to approve`() {
        // The watch never checked expiry, so it offered Approve for a request
        // the bridge had already given up on — a tap that could only fail.
        val decision = wristDecision(agent(approval = PendingApproval("r1", "Bash", "rm -rf", past, past)), now)
        assertTrue(decision is WristDecision.Elsewhere)
    }

    @Test
    fun `a durable question with no event to answer against goes to the host`() {
        // The watch reads a durable Request now rather than only its own
        // events — which this screen shows the same way either way, since
        // there is no event to send an answer against. What changed is the
        // notification, which can now say what is being asked instead of
        // falling back to the session's task.
        val decision = wristDecision(
            agent(question = PendingQuestion("r2", "Which provider?", listOf("Stripe"), past, soon)),
            now,
        )
        assertTrue(decision is WristDecision.Elsewhere)
    }

    @Test
    fun `an ask the runtime moved past is not offered`() {
        // The watch took the newest *question* rather than the newest event, so
        // a question buried under later work still offered buttons.
        val decision = wristDecision(
            agent(
                events = listOf(
                    question("q1", "2026-09-01T11:50:00Z"),
                    AgentEvent(id = "t1", kind = "tool", summary = "Edit", createdAt = "2026-09-01T11:55:00Z"),
                ),
            ),
            now,
        )
        assertTrue(decision is WristDecision.Elsewhere)
    }

    @Test
    fun `the newest question is answerable`() {
        val decision = wristDecision(agent(events = listOf(question("q1", "2026-09-01T11:55:00Z"))), now)
        assertEquals("q1", (decision as WristDecision.Answer).event.id)
    }

    @Test
    fun `a free-text question belongs on the host`() {
        // Nothing to tap, so the watch says where it can be answered rather
        // than showing an empty list of options.
        val decision = wristDecision(
            agent(events = listOf(question("q1", "2026-09-01T11:55:00Z", options = emptyList()))),
            now,
        )
        assertTrue(decision is WristDecision.Elsewhere)
    }

    @Test
    fun `a session that is not waiting is asking nothing`() {
        val decision = wristDecision(
            agent(state = "running", events = listOf(question("q1", "2026-09-01T11:55:00Z"))),
            now,
        )
        assertTrue(decision is WristDecision.None)
    }

    @Test
    fun `an approval outranks a question`() {
        // The same precedence the bridge's own pendingBlockFrom uses: an
        // approval is the one holding a tool call open.
        val decision = wristDecision(
            agent(
                events = listOf(question("q1", "2026-09-01T11:55:00Z")),
                approval = PendingApproval("r1", "Bash", "rm -rf", past, soon),
            ),
            now,
        )
        assertTrue(decision is WristDecision.Approve)
    }
}
