package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import org.junit.Assert.assertEquals
import org.junit.Test

class StartSessionPolicyTest {
    private fun agent(id: String, cwd: String?, lastSeenAt: String) = Agent(
        id = id, name = "Pi", project = "deck", cwd = cwd, model = "gpt-5",
        state = "idle", task = "Working", tokens = 0, costUsd = 0.0,
        lastSeenAt = lastSeenAt,
    )

    @Test
    fun mostRecentlyActiveDirectoryComesFirst() {
        val agents = listOf(
            agent("a", "/repos/old", "2026-08-24T09:00:00Z"),
            agent("b", "/repos/new", "2026-08-24T11:00:00Z"),
            agent("c", "/repos/middle", "2026-08-24T10:00:00Z"),
        )
        assertEquals(listOf("/repos/new", "/repos/middle", "/repos/old"), knownWorkingDirectories(agents))
    }

    @Test
    fun sharedDirectoryAppearsOnceAtItsFreshestSeat() {
        val agents = listOf(
            agent("a", "/repos/deck", "2026-08-24T08:00:00Z"),
            agent("b", "/repos/other", "2026-08-24T09:00:00Z"),
            agent("c", "/repos/deck", "2026-08-24T10:00:00Z"),
        )
        assertEquals(listOf("/repos/deck", "/repos/other"), knownWorkingDirectories(agents))
    }

    @Test
    fun sessionsWithoutADirectoryOfferNothing() {
        val agents = listOf(
            agent("a", null, "2026-08-24T10:00:00Z"),
            agent("b", "", "2026-08-24T11:00:00Z"),
            agent("c", "/repos/deck", "2026-08-24T09:00:00Z"),
        )
        assertEquals(listOf("/repos/deck"), knownWorkingDirectories(agents))
    }

    @Test
    fun unparseableTimestampsSortLastRatherThanThrowing() {
        val agents = listOf(
            agent("a", "/repos/broken", "not-a-time"),
            agent("b", "/repos/deck", "2026-08-24T09:00:00Z"),
        )
        assertEquals(listOf("/repos/deck", "/repos/broken"), knownWorkingDirectories(agents))
    }

    @Test
    fun chipLabelKeepsTheLastTwoSegments() {
        assertEquals("…/vibecoding/agent-control-dashboard", workingDirectoryLabel("/Users/d/tmp/code/personal/vibecoding/agent-control-dashboard"))
        assertEquals("/repos/deck", workingDirectoryLabel("/repos/deck"))
        assertEquals("/deck", workingDirectoryLabel("/deck"))
    }
}
