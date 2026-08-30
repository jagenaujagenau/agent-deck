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
    fun `errored and waiting sessions are the ones needing you`() {
        val summary = DeckSummaries.of(
            listOf(agent("a", "waiting"), agent("b", "running"), agent("c", "idle"), agent("d", "error")),
            observedAt = 1L,
        )
        // The stuck one is a person's problem: an error cannot move without
        // one, exactly like a session blocked on an approval.
        assertEquals(2, summary.attention)
        assertEquals(1, summary.running)
        assertEquals(1, summary.idle)
    }

    @Test
    fun `the glanceable surfaces sort by the same attention priority as every list`() {
        val summary = DeckSummaries.of(
            listOf(
                agent("idle1", "idle"),
                agent("run1", "running"),
                agent("wait1", "waiting"),
                agent("err1", "error"),
            ),
            observedAt = 1L,
        )
        assertEquals(listOf("err1", "wait1", "run1", "idle1"), summary.lines.map { it.agentId })
        assertTrue(summary.lines.first().needsYou)
    }

    @Test
    fun `offline sessions are not counted at all`() {
        val summary = DeckSummaries.of(
            listOf(agent("a", "offline"), agent("b", "running")),
            observedAt = 1L,
        )
        assertEquals(1, summary.total)
        assertEquals(1, summary.lines.size)
    }

    @Test
    fun `waiting comes first, then working, then the rest`() {
        val summary = DeckSummaries.of(
            listOf(agent("idle1", "idle"), agent("run1", "running"), agent("wait1", "waiting")),
            observedAt = 1L,
        )
        assertEquals(listOf("wait1", "run1", "idle1"), summary.lines.map { it.agentId })
    }

    @Test
    fun `the longest wait leads`() {
        val summary = DeckSummaries.of(
            listOf(
                agent("recent", "waiting", lastSeenAt = "2026-08-25T12:00:00Z"),
                agent("oldest", "waiting", lastSeenAt = "2026-08-25T09:00:00Z"),
            ),
            observedAt = 1L,
        )
        assertEquals("oldest", summary.lines.first().agentId)
    }

    @Test
    fun `a resting deck still has something to show`() {
        // This is the state the deck is in most of the time. A widget with
        // nothing to draw here reads as broken rather than calm.
        val summary = DeckSummaries.of(
            listOf(agent("a", "running", task = "Using Bash"), agent("b", "idle")),
            observedAt = 1L,
        )
        assertEquals(2, summary.lines.size)
        assertTrue(summary.needing.isEmpty())
    }

    @Test
    fun `the count is the real one even when the list is capped`() {
        val many = (1..12).map { agent("a$it", "waiting") }
        val summary = DeckSummaries.of(many, observedAt = 1L)
        assertEquals(DeckSummaries.MAX_LINES, summary.lines.size)
        // Twelve are waiting. Reporting eight because eight fit would say the
        // other four are fine.
        assertEquals(12, summary.attention)
    }

    @Test
    fun `overflow counts everything a surface could not draw`() {
        val many = (1..12).map { agent("a$it", "waiting") }
        val summary = DeckSummaries.of(many, observedAt = 1L)
        assertEquals(9, DeckSummaries.overflow(summary, shown = 3))
        assertEquals(0, DeckSummaries.overflow(summary, shown = 12))
    }

    @Test
    fun `a session with no project falls back to something recognisable`() {
        val summary = DeckSummaries.of(listOf(agent("a", "waiting", project = "")), observedAt = 1L)
        assertTrue(summary.lines.first().project.isNotBlank())
    }

    @Test
    fun `a waiting session with no task still says something`() {
        val summary = DeckSummaries.of(listOf(agent("a", "waiting", task = "")), observedAt = 1L)
        assertEquals("Needs your attention", summary.lines.first().detail)
    }

    @Test
    fun `the headline never reports zero of anything`() {
        assertEquals("1 needs you", DeckSummaries.headline(DeckSummaries.of(listOf(agent("a", "waiting")), 1L)))
        assertEquals("2 need you", DeckSummaries.headline(DeckSummaries.of(listOf(agent("a", "waiting"), agent("b", "waiting")), 1L)))
        assertEquals("1 working", DeckSummaries.headline(DeckSummaries.of(listOf(agent("a", "running")), 1L)))
        assertEquals("All idle", DeckSummaries.headline(DeckSummaries.of(listOf(agent("a", "idle")), 1L)))
        assertEquals("No sessions", DeckSummaries.headline(DeckSummaries.of(emptyList(), 1L)))
    }

    @Test
    fun `a summary that never reached the bridge says so rather than showing an empty deck`() {
        assertEquals("Not connected", DeckSummaries.headline(DeckSummary()))
    }
}

class DeckSummaryStoreTest {
    private fun summary(attention: Int = 0, running: Int = 0, at: Long = 0L) = DeckSummary(
        lines = (1..attention).map { DeckLine("a$it", "proj", "Approval: Bash", needsYou = true) },
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
        // update is a system round trip.
        assertFalse(DeckSummaryStore.differs(summary(at = 1L), summary(at = 9_999L)))
    }

    @Test
    fun `reaching the bridge for the first time is worth a redraw`() {
        // "Not connected" becoming "All idle" is the most important change a
        // widget ever shows, and both have zero of everything.
        assertTrue(DeckSummaryStore.differs(DeckSummary(), summary()))
    }

    @Test
    fun `a session changing what it is doing is a change at the same count`() {
        val one = DeckSummary(lines = listOf(DeckLine("a", "p", "Using Bash")), running = 1)
        val other = DeckSummary(lines = listOf(DeckLine("a", "p", "Using Read")), running = 1)
        assertTrue(DeckSummaryStore.differs(one, other))
    }
}

class HarnessTest {
    @Test
    fun `every adapter that prefixes its ids is recognised by it`() {
        assertEquals(Harness.Claude, Harnesses.of("claude-abc", "Claude · fx · 1"))
        assertEquals(Harness.Codex, Harnesses.of("codex-abc", "Codex · fx · 1"))
        assertEquals(Harness.OpenCode, Harnesses.of("opencode-abc", "OpenCode · fx · 1"))
        assertEquals(Harness.Managed, Harnesses.of("managed-abc", "Managed Claude"))
    }

    @Test
    fun `the wire's own runtime word outranks every guess`() {
        // A renamed Pi session loses the name heuristic; the runtime field holds.
        assertEquals(Harness.Pi, Harnesses.of("01a02e7b", "fx backfill", runtime = "pi"))
        assertEquals(Harness.Claude, Harnesses.of("x-1", "anything", runtime = "claude"))
        // A bridge-hosted session stays Managed even though its runtime is claude.
        assertEquals(Harness.Managed, Harnesses.of("managed-abc", "Managed Claude", runtime = "claude"))
        // A runtime word the deck does not know falls back to the prefix.
        assertEquals(Harness.Codex, Harnesses.of("codex-abc", "Codex · fx", runtime = "cursor"))
    }

    @Test
    fun `Pi is read from its name, having no prefix to read`() {
        // Pi names sessions from the runtime's own id, which carries no prefix.
        assertEquals(Harness.Pi, Harnesses.of("01a02e7b-3852-794f", "Pi · agent-control-dashboard"))
    }

    @Test
    fun `an unfamiliar runtime is marked as unknown rather than guessed at`() {
        assertEquals(Harness.Unknown, Harnesses.of("cursor-abc", "Cursor · fx"))
    }

    @Test
    fun `a project merely named after a runtime is not that runtime`() {
        // "Pipeline" starts with Pi. The separator is what makes it a name.
        assertEquals(Harness.Unknown, Harnesses.of("x-1", "Pipeline · fx"))
    }
}

class DeckDetailTest {
    private fun agent(
        state: String = "running",
        task: String = "Bash completed",
        events: List<AgentEvent> = emptyList(),
    ) = Agent(
        id = "claude-a",
        name = "Claude · fx · 1",
        project = "fx",
        model = "Claude Code",
        state = state,
        task = task,
        tokens = 0L,
        costUsd = 0.0,
        lastSeenAt = "2026-08-25T10:00:00Z",
        events = events,
    )

    private fun event(kind: String, summary: String, detail: String, at: String) =
        AgentEvent(id = at, kind = kind, summary = summary, detail = detail, createdAt = at)

    @Test
    fun `thinking is shown while it is the latest thing to happen`() {
        val detail = DeckSummaries.detailFor(
            agent(events = listOf(event("thought", "Reasoning", "Weighing two approaches", "T3"))),
        )
        assertEquals("Weighing two approaches", detail)
    }

    @Test
    fun `a finished reply supersedes the thinking that led to it`() {
        // A stale thought beside a finished reply reports a session as still
        // working something out that it has already answered.
        val detail = DeckSummaries.detailFor(
            agent(
                events = listOf(
                    event("thought", "Reasoning", "Weighing two approaches", "T1"),
                    event("output", "Response", "Went with the second one", "T2"),
                ),
            ),
        )
        assertEquals("Went with the second one", detail)
    }

    @Test
    fun `tool chatter is never the detail`() {
        // "Bash completed" says the machine is busy, which the state says too.
        val detail = DeckSummaries.detailFor(
            agent(
                events = listOf(
                    event("output", "Response", "Here is what I found", "T1"),
                    event("tool", "Using Bash", "ls -la", "T2"),
                ),
            ),
        )
        assertEquals("Here is what I found", detail)
    }

    @Test
    fun `the task carries it when no events arrived`() {
        // The watch is relayed one event per session, and it may be neither.
        assertEquals("Bash completed", DeckSummaries.detailFor(agent(events = emptyList())))
    }

    @Test
    fun `a waiting session with nothing at all still says something`() {
        assertEquals(
            "Needs your attention",
            DeckSummaries.detailFor(agent(state = "waiting", task = "", events = emptyList())),
        )
    }

    @Test
    fun `a transcript's newlines are flattened into one readable line`() {
        val detail = DeckSummaries.detailFor(
            agent(events = listOf(event("thought", "Reasoning", "First.\n\n  Then second.", "T1"))),
        )
        assertEquals("First. Then second.", detail)
    }

    @Test
    fun `a long thought is clipped rather than filling the widget`() {
        val long = "word ".repeat(200)
        val detail = DeckSummaries.detailFor(
            agent(events = listOf(event("thought", "Reasoning", long, "T1"))),
        )
        assertTrue(detail.length <= 140)
        assertTrue(detail.endsWith("…"))
    }
}
