package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.BridgeInfo
import dev.agentdeck.shared.BridgeSnapshot
import dev.agentdeck.shared.DeckSummaries
import dev.agentdeck.shared.Summary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the watch is sent, and whether the tile can say anything useful from it.
 *
 * The relay is trimmed hard to stay under the Wear data limit, and trimming to
 * the single newest event left the tile reporting "Bash completed" for sessions
 * that had just finished explaining themselves.
 */
class WearRelayDetailTest {
    private fun event(id: String, kind: String, summary: String, detail: String, at: String) =
        AgentEvent(id = id, kind = kind, summary = summary, detail = detail, createdAt = at)

    private fun snapshotOf(events: List<AgentEvent>) = BridgeSnapshot(
        bridge = BridgeInfo(status = "connected", name = "test", timestamp = "T"),
        summary = Summary(active = 1, waiting = 0, errors = 0, tokens = 0, costUsd = 0.0),
        agents = listOf(
            Agent(
                id = "claude-a",
                name = "Claude · fx · 1",
                project = "fx",
                model = "Claude Code",
                state = "running",
                task = "Bash completed",
                tokens = 0L,
                costUsd = 0.0,
                lastSeenAt = "T",
                events = events,
            ),
        ),
    )

    @Test
    fun `a reply survives the trim even when a tool call is newer`() {
        val relayed = wearRelaySnapshot(
            snapshotOf(
                listOf(
                    event("1", "output", "Response", "Went with the second approach", "T1"),
                    event("2", "tool", "Using Bash", "ls", "T2"),
                ),
            ),
            archived = emptySet(),
        )
        // Both are carried: the newest for the app's activity line, the spoken
        // one so the tile has something worth reading.
        assertEquals(2, relayed.agents.first().events.size)
        assertEquals(
            "Went with the second approach",
            DeckSummaries.detailFor(relayed.agents.first()),
        )
    }

    @Test
    fun `nothing is duplicated when the newest event is the spoken one`() {
        val relayed = wearRelaySnapshot(
            snapshotOf(listOf(event("1", "thought", "Reasoning", "Weighing it up", "T1"))),
            archived = emptySet(),
        )
        assertEquals(1, relayed.agents.first().events.size)
    }

    @Test
    fun `a session that has never spoken still relays its latest event`() {
        val relayed = wearRelaySnapshot(
            snapshotOf(listOf(event("1", "tool", "Using Bash", "ls", "T1"))),
            archived = emptySet(),
        )
        assertEquals(1, relayed.agents.first().events.size)
        assertEquals("Bash completed", DeckSummaries.detailFor(relayed.agents.first()))
    }

    @Test
    fun `the trim still bounds what is sent`() {
        val long = "x".repeat(5_000)
        val relayed = wearRelaySnapshot(
            snapshotOf(listOf(event("1", "output", "Response", long, "T1"))),
            archived = emptySet(),
        )
        assertTrue(relayed.agents.first().events.first().detail!!.length <= 1_200)
    }
}
