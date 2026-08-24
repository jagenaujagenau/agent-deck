package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.BridgeInfo
import dev.agentdeck.shared.BridgeSnapshot
import dev.agentdeck.shared.BridgeSnapshotPatch
import dev.agentdeck.shared.Summary
import dev.agentdeck.shared.applyPatch
import org.junit.Assert.assertEquals
import org.junit.Test

class SnapshotPatchTest {
    private val bridge = BridgeInfo(status = "connected", name = "Local bridge", timestamp = "2026-08-25T00:00:00Z")
    private val summary = Summary(active = 1, waiting = 0, errors = 0, tokens = 0, costUsd = 0.0)

    private fun agent(id: String, state: String = "running", task: String = "working") =
        Agent(id = id, name = id, project = "p", model = "m", state = state, task = task, tokens = 0, costUsd = 0.0, lastSeenAt = "2026-08-25T00:00:00Z")

    private fun snapshot(vararg agents: Agent) = BridgeSnapshot(1, bridge, summary, agents.toList())

    @Test
    fun `an agent the patch omits is carried over untouched`() {
        val before = snapshot(agent("a", task = "first"), agent("b", task = "second"))
        val patch = BridgeSnapshotPatch(2, bridge, summary, agents = listOf(agent("a", task = "updated")))

        val after = before.applyPatch(patch)
        assertEquals(listOf("a", "b"), after.agents.map { it.id })
        assertEquals("updated", after.agents.first { it.id == "a" }.task)
        // b was never sent again, so it must survive intact rather than disappear.
        assertEquals("second", after.agents.first { it.id == "b" }.task)
    }

    @Test
    fun `order is preserved for existing agents and new ones append`() {
        val before = snapshot(agent("a"), agent("b"))
        val patch = BridgeSnapshotPatch(2, bridge, summary, agents = listOf(agent("c"), agent("b", task = "changed")))

        assertEquals(listOf("a", "b", "c"), before.applyPatch(patch).agents.map { it.id })
    }

    @Test
    fun `removed agents are dropped`() {
        val before = snapshot(agent("a"), agent("b"), agent("c"))
        val patch = BridgeSnapshotPatch(2, bridge, summary, removed = listOf("b"))

        assertEquals(listOf("a", "c"), before.applyPatch(patch).agents.map { it.id })
    }

    @Test
    fun `sequence and summary come from the patch`() {
        val before = snapshot(agent("a"))
        val patch = BridgeSnapshotPatch(9, bridge, Summary(active = 3, waiting = 2, errors = 1, tokens = 5, costUsd = 1.5))

        val after = before.applyPatch(patch)
        assertEquals(9, after.sequence)
        assertEquals(3, after.summary.active)
        assertEquals(2, after.summary.waiting)
    }

    @Test
    fun `an empty patch changes nothing but the sequence`() {
        val before = snapshot(agent("a"), agent("b"))
        val after = before.applyPatch(BridgeSnapshotPatch(2, bridge, summary))

        assertEquals(before.agents, after.agents)
        assertEquals(2, after.sequence)
    }
}
