package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.PendingApproval
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import dev.agentdeck.shared.AttentionPolicy

class ApprovalNotifierTest {
    @Test
    fun `only waiting agents with a concrete approval event produce a key`() {
        assertNull(AttentionPolicy.approvalKey(agent(state = "idle", events = listOf(approval("one")))))
        assertNull(AttentionPolicy.approvalKey(agent(state = "waiting", events = emptyList())))
        assertNull(AttentionPolicy.approvalKey(agent(state = "waiting", events = listOf(warning("one")))))
        assertEquals("agent:one", AttentionPolicy.approvalKey(agent(state = "waiting", events = listOf(approval("one")))))
    }

    @Test
    fun `completed state rejects a delayed waiting snapshot`() {
        val waiting = agent("waiting", listOf(approval("approval", "2026-01-01T00:00:01Z")), "2026-01-01T00:00:01Z")
        val completed = agent("idle", waiting.events, "2026-01-01T00:00:03Z")
        val staleWaiting = waiting.copy(lastSeenAt = "2026-01-01T00:00:02Z")

        val first = AttentionPolicy.decide(waiting, null, false, null)
        assertEquals(AttentionPolicy.Action.Notify, first.action)
        val resolved = AttentionPolicy.decide(completed, first.observedAt, first.resolved, first.approvalKey)
        assertEquals(AttentionPolicy.Action.Cancel, resolved.action)
        val delayed = AttentionPolicy.decide(staleWaiting, resolved.observedAt, resolved.resolved, first.approvalKey)
        assertEquals(AttentionPolicy.Action.Ignore, delayed.action)
        assertEquals(true, delayed.resolved)
    }

    @Test
    fun `repeated resolved heartbeats do not cancel repeatedly`() {
        val idle = agent("idle", emptyList(), "2026-01-01T00:00:01Z")
        val first = AttentionPolicy.decide(idle, null, false, null)
        assertEquals(AttentionPolicy.Action.Cancel, first.action)
        val heartbeat = AttentionPolicy.decide(idle.copy(lastSeenAt = "2026-01-01T00:00:02Z"), first.observedAt, first.resolved, null)
        assertEquals(AttentionPolicy.Action.Ignore, heartbeat.action)
    }

    @Test
    fun `resolved state wins when waiting snapshot has the same timestamp`() {
        val waiting = agent("waiting", listOf(approval("approval", "2026-01-01T00:00:01Z")), "2026-01-01T00:00:01Z")
        val resolved = AttentionPolicy.decide(waiting.copy(state = "idle"), "2026-01-01T00:00:01Z", false, "agent:approval")
        val delayed = AttentionPolicy.decide(waiting, resolved.observedAt, resolved.resolved, "agent:approval")
        assertEquals(AttentionPolicy.Action.Ignore, delayed.action)
    }

    @Test
    fun `historical approval event without a live lease never notifies`() {
        val stale = agent("waiting", listOf(approval("old"))).copy(pendingApproval = null)
        assertNull(AttentionPolicy.approvalKey(stale))
        assertNotEquals(AttentionPolicy.Action.Notify, AttentionPolicy.decide(stale, null, false, null).action)
    }

    @Test
    fun `expired approval lease never notifies`() {
        val expired = agent("waiting", listOf(approval("old"))).copy(
            pendingApproval = PendingApproval("old", "Bash", "command", "2020-01-01T00:00:00Z", "2020-01-01T00:01:00Z"),
        )
        assertNull(AttentionPolicy.approvalKey(expired))
    }

    @Test
    fun `runtime authoritative mode cannot produce approval notifications`() {
        val auto = agent("waiting", listOf(approval("auto"))).copy(capabilities = listOf("prompt", "steer"))
        assertNull(AttentionPolicy.approvalKey(auto))
        assertNotEquals(AttentionPolicy.Action.Notify, AttentionPolicy.decide(auto, null, false, null).action)
    }

    @Test
    fun `question attention notifies without becoming an approval`() {
        val question = AgentEvent("question", "question", "Question", "Choose one", "2026-01-01T00:00:01Z", options = listOf("A", "B"))
        val agent = agent("waiting", listOf(question), "2026-01-01T00:00:01Z")
        assertNull(AttentionPolicy.approvalKey(agent))
        assertEquals(AttentionPolicy.Action.Notify, AttentionPolicy.decide(agent, null, false, null).action)
    }

    @Test
    fun `replayed snapshots have the same key but a new approval changes it`() {
        val first = agent(state = "waiting", events = listOf(approval("first")))
        val replay = first.copy()
        val second = agent(state = "waiting", events = first.events + approval("second"))

        assertEquals(AttentionPolicy.approvalKey(first), AttentionPolicy.approvalKey(replay))
        assertNotEquals(AttentionPolicy.approvalKey(first), AttentionPolicy.approvalKey(second))
        assertEquals("agent:second", AttentionPolicy.approvalKey(second))
    }

    private fun agent(state: String, events: List<AgentEvent>, lastSeenAt: String = "2026-01-01T00:00:00Z") = Agent(
        id = "agent",
        name = "Claude",
        project = "project",
        model = "model",
        state = state,
        task = "task",
        tokens = 0,
        costUsd = 0.0,
        lastSeenAt = lastSeenAt,
        events = events,
        capabilities = listOf("approve", "reject", "prompt", "steer"),
        pendingApproval = events.lastOrNull { it.summary.startsWith("Approval required") }?.let {
            PendingApproval(it.id, "Bash", it.detail ?: "command", it.createdAt, "2099-01-01T00:00:00Z")
        },
    )

    private fun approval(id: String, createdAt: String = "2026-01-01T00:00:00Z") = AgentEvent(id, "warning", "Approval required: Bash", "command", createdAt)
    private fun warning(id: String) = AgentEvent(id, "warning", "Connection warning", "detail", "2026-01-01T00:00:00Z")
}
