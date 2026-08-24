package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.BridgeInfo
import dev.agentdeck.shared.BridgeSnapshot
import dev.agentdeck.shared.Summary
import org.junit.Assert.assertEquals
import org.junit.Test

class ArchivePolicyTest {
    private fun agent(id: String = "session-1", state: String = "waiting", events: List<AgentEvent> = emptyList()) = Agent(
        id = id, name = "Claude", project = "deck", model = "claude", state = state,
        task = "Needs input", tokens = 0, costUsd = 0.0, lastSeenAt = "2026-08-24T10:00:00Z", events = events,
    )

    @Test
    fun newEventsDoNotChangeArchiveIdentity() {
        val before = agentArchiveKey(agent())
        val after = agentArchiveKey(agent(events = listOf(AgentEvent("new-event", "output", "Update", createdAt = "2026-08-24T10:01:00Z"))))
        assertEquals(before, after)
    }

    @Test
    fun legacyEventBasedKeysMigrateToStableSessionIds() {
        assertEquals(setOf("session-1", "session-2"), normalizeArchivedAgentKeys(setOf("session-1:event-7", "session-2")))
    }

    @Test
    fun archivedAttentionIsExcludedFromBoardMetrics() {
        val visible = unarchivedAgents(listOf(agent()), setOf("session-1"))
        assertEquals(0, attentionCount(visible))
    }

    @Test
    fun archivedAttentionIsRemovedFromRelayedSnapshots() {
        val snapshot = BridgeSnapshot(
            sequence = 1, bridge = BridgeInfo("connected", "Bridge", "2026-08-24T10:00:00Z"),
            summary = Summary(active = 1, waiting = 1, errors = 0, tokens = 0, costUsd = 0.0),
            agents = listOf(agent()),
        )
        val visible = archiveFilteredSnapshot(snapshot, setOf("session-1"))
        assertEquals(0, visible.agents.size)
        assertEquals(0, visible.summary.active)
        assertEquals(0, visible.summary.waiting)
    }

    @Test
    fun wearProjectionDropsHistoryAndKeepsOnlyLatestCompactEvent() {
        val old = AgentEvent("old", "output", "Old", detail = "old", createdAt = "2026-08-24T10:00:00Z")
        val latest = AgentEvent("latest", "output", "Latest", detail = "x".repeat(2_000), createdAt = "2026-08-24T10:01:00Z")
        val snapshot = BridgeSnapshot(
            sequence = 2, bridge = BridgeInfo("connected", "Bridge", "2026-08-24T10:02:00Z"),
            summary = Summary(active = 1, waiting = 1, errors = 0, tokens = 0, costUsd = 0.0),
            agents = listOf(agent(events = listOf(old, latest)), agent(id = "offline", state = "offline")),
        )
        val wear = wearRelaySnapshot(snapshot, emptySet())
        assertEquals(listOf("session-1"), wear.agents.map { it.id })
        assertEquals(listOf("latest"), wear.agents.single().events.map { it.id })
        assertEquals(1_200, wear.agents.single().events.single().detail?.length)
    }
}
