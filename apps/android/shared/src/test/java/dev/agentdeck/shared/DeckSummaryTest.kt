package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeckSummaryTest {
    private fun agent(
        id: String,
        state: String,
        project: String = "proj",
        task: String = "Doing something",
        lastSeenAt: String = "2026-08-25T10:00:00Z",
    ) = Agent(
        id = id,
        name = "Claude · $project · $id",
        project = project,
        model = "Claude Code",
        state = state,
        task = task,
        tokens = 0L,
        costUsd = 0.0,
        lastSeenAt = lastSeenAt,
    )

    @Test
    fun `only waiting sessions are counted as needing you`() {
        val summary = DeckSummaries.of(
            listOf(
                agent("a", "waiting"),
                agent("b", "running"),
                agent("c", "idle"),
                agent("d", "error"),
            ),
            observedAt = 1L,
        )
        assertEquals(1, summary.attention)
        assertEquals(1, summary.running)
        // An errored session is not asking for you; it is counted, not surfaced.
        assertEquals(2, summary.idle)
    }

    @Test
    fun `offline sessions are not counted at all`() {
        // A session the bridge has lost is not part of the deck a person is
        // looking at, and counting it makes every number quietly wrong.
        val summary = DeckSummaries.of(
            listOf(agent("a", "offline"), agent("b", "running")),
            observedAt = 1L,
        )
        assertEquals(1, summary.total)
        assertEquals(0, summary.attention)
    }

    @Test
    fun `the longest wait is listed first`() {
        val summary = DeckSummaries.of(
            listOf(
                agent("recent", "waiting", lastSeenAt = "2026-08-25T12:00:00Z"),
                agent("oldest", "waiting", lastSeenAt = "2026-08-25T09:00:00Z"),
            ),
            observedAt = 1L,
        )
        assertEquals("oldest", summary.needing.first().agentId)
    }

    @Test
    fun `no more than a glance is listed, but the count is the real one`() {
        val many = (1..6).map { agent("a$it", "waiting") }
        val summary = DeckSummaries.of(many, observedAt = 1L)
        assertEquals(DeckSummaries.MAX_NEEDING, summary.needing.size)
        // Six are waiting. Reporting three because three fit would say the
        // other three are fine.
        assertEquals(6, summary.attention)
    }

    @Test
    fun `overflow says how many did not fit`() {
        val many = (1..6).map { agent("a$it", "waiting") }
        val summary = DeckSummaries.of(many, observedAt = 1L)
        assertEquals(3, DeckSummaries.overflow(summary, summary.needing.size))
    }

    @Test
    fun `nothing overflows when everything fits`() {
        val summary = DeckSummaries.of(listOf(agent("a", "waiting")), observedAt = 1L)
        assertEquals(0, DeckSummaries.overflow(summary, summary.needing.size))
    }

    @Test
    fun `a session with no project falls back to something recognisable`() {
        val summary = DeckSummaries.of(listOf(agent("a", "waiting", project = "")), observedAt = 1L)
        assertTrue(summary.needing.first().project.isNotBlank())
    }

    @Test
    fun `a waiting session with no task still says something`() {
        val summary = DeckSummaries.of(listOf(agent("a", "waiting", task = "")), observedAt = 1L)
        assertEquals("Needs your attention", summary.needing.first().asking)
    }

    @Test
    fun `the resting line never reports zero of anything`() {
        // "0 need you" reports a problem the deck does not have.
        val working = DeckSummaries.of(listOf(agent("a", "running")), observedAt = 1L)
        assertEquals("1 working", DeckSummaries.restingLine(working))

        val quiet = DeckSummaries.of(listOf(agent("a", "idle")), observedAt = 1L)
        assertEquals("All idle", DeckSummaries.restingLine(quiet))

        val empty = DeckSummaries.of(emptyList(), observedAt = 1L)
        assertEquals("No sessions", DeckSummaries.restingLine(empty))
    }

    @Test
    fun `a summary that never reached the bridge says so rather than showing an empty deck`() {
        // The default is the state a widget is in before its first fetch, and
        // "No sessions" there would be a confident lie.
        assertEquals("Not connected", DeckSummaries.restingLine(DeckSummary()))
    }
}

class DeckSummaryStoreTest {
    private fun summary(attention: Int = 0, running: Int = 0, at: Long = 0L) = DeckSummary(
        needing = (1..attention).map { NeedsYou("a$it", "proj", "Approval: Bash") },
        attention = attention,
        running = running,
        observedAt = at,
        reachedBridge = true,
    )

    @Test
    fun `a redraw is asked for when the counts change`() {
        assertTrue(DeckSummaryStore.differs(summary(attention = 1), summary(attention = 2)))
        assertTrue(DeckSummaryStore.differs(summary(running = 1), summary(running = 2)))
    }

    @Test
    fun `a new timestamp alone is not worth a redraw`() {
        // The relay arrives far more often than the deck changes, and a tile
        // update is a system round trip. Redrawing on every snapshot would
        // spend battery to display the same thing.
        assertFalse(DeckSummaryStore.differs(summary(at = 1L), summary(at = 9_999L)))
    }

    @Test
    fun `reaching the bridge for the first time is worth a redraw`() {
        // "Not connected" becoming "All idle" is the most important change a
        // widget ever shows, and both have zero of everything.
        assertTrue(DeckSummaryStore.differs(DeckSummary(), summary()))
    }

    @Test
    fun `a different session waiting is a change even at the same count`() {
        val one = DeckSummary(needing = listOf(NeedsYou("a", "p", "Approval: Bash")), attention = 1)
        val other = DeckSummary(needing = listOf(NeedsYou("b", "q", "Which branch?")), attention = 1)
        assertTrue(DeckSummaryStore.differs(one, other))
    }
}
