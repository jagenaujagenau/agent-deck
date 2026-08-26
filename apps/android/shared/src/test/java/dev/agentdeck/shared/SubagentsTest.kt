package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubagentsTest {
    private fun event(
        id: String,
        summary: String,
        at: String,
        subagentId: String? = null,
        subagentType: String? = null,
        tool: String? = null,
    ) = AgentEvent(
        id = id,
        kind = "output",
        summary = summary,
        createdAt = at,
        tool = tool,
        subagentId = subagentId,
        subagentType = subagentType,
    )

    @Test
    fun `the parent's own work belongs to no subagent`() {
        val events = listOf(
            event("1", "Using Read", "2026-08-26T10:00:00Z"),
            event("2", "Using Bash", "2026-08-26T10:01:00Z"),
        )
        assertEquals(emptyList<SubagentRun>(), subagentRuns(events))
    }

    @Test
    fun `two subagents working at once stay apart`() {
        // The case this exists for: their tool calls interleave in one stream.
        val events = listOf(
            event("1", "Using Read", "2026-08-26T10:00:00Z", "aaa", "general-purpose"),
            event("2", "Using Grep", "2026-08-26T10:00:30Z", "bbb", "Explore"),
            event("3", "Using Bash", "2026-08-26T10:01:00Z", "aaa", "general-purpose"),
            event("4", "Using Read", "2026-08-26T10:01:30Z", "bbb", "Explore"),
        )
        val runs = subagentRuns(events)
        assertEquals(listOf("aaa", "bbb"), runs.map { it.id })
        assertEquals(listOf("general-purpose", "Explore"), runs.map { it.type })
        assertEquals(listOf(2, 2), runs.map { it.eventCount })
    }

    @Test
    fun `ordered by when each started, not by which moved last`() {
        val events = listOf(
            event("1", "Using Read", "2026-08-26T10:00:00Z", "first", "Explore"),
            event("2", "Using Read", "2026-08-26T10:05:00Z", "second", "general-purpose"),
            // "first" moves again afterwards; it still comes first.
            event("3", "Using Bash", "2026-08-26T10:09:00Z", "first", "Explore"),
        )
        assertEquals(listOf("first", "second"), subagentRuns(events).map { it.id })
    }

    @Test
    fun `a completion marks the run finished`() {
        val events = listOf(
            event("1", "Using Read", "2026-08-26T10:00:00Z", "aaa", "Explore"),
            event("2", "Explore subagent finished", "2026-08-26T10:02:00Z", "aaa", "Explore", tool = "Task"),
        )
        val run = subagentRuns(events).single()
        assertTrue(run.finished)
        // Not "Explore subagent finished" - that says only what `finished`
        // already says, and loses the work it did.
        assertEquals("Using Read", run.activity)
    }

    @Test
    fun `a running subagent reports its newest step`() {
        val events = listOf(
            event("1", "Using Read", "2026-08-26T10:00:00Z", "aaa", "general-purpose"),
            event("2", "Using Bash", "2026-08-26T10:01:00Z", "aaa", "general-purpose"),
        )
        val run = subagentRuns(events).single()
        assertFalse(run.finished)
        assertEquals("Using Bash", run.activity)
    }

    @Test
    fun `a run with no type reported still names itself`() {
        val events = listOf(event("1", "Using Read", "2026-08-26T10:00:00Z", "aaa"))
        assertEquals("Subagent", subagentRuns(events).single().type)
    }

    @Test
    fun `one subagent's view holds only its own work`() {
        val events = listOf(
            event("1", "parent work", "2026-08-26T10:00:00Z"),
            event("2", "Using Read", "2026-08-26T10:00:30Z", "aaa", "Explore"),
            event("3", "Using Grep", "2026-08-26T10:01:00Z", "bbb", "Explore"),
        )
        assertEquals(listOf("2"), eventsOfSubagent(events, "aaa").map { it.id })
    }
}

class SubagentMessageTest {
    private fun completion(detail: String?) = AgentEvent(
        id = "c1",
        kind = "output",
        summary = "general-purpose subagent finished",
        detail = detail,
        createdAt = "2026-08-26T10:00:00Z",
        tool = "Task",
        subagentId = "aaa",
        subagentType = "general-purpose",
    )

    @Test
    fun `a subagent's parting message is conversation`() {
        // It is the only thing a subagent ever says, and it arrives carrying a
        // tool - which every other rule here treats as chatter.
        val entries = conversationEntries(listOf(completion("Here is what I found.")))
        assertEquals(1, entries.size)
        assertEquals(ConversationRole.Agent, entries.single().role)
        assertEquals("Here is what I found.", entries.single().content)
    }

    @Test
    fun `a completion with nothing to say is not a message`() {
        assertEquals(emptyList<ConversationEntry>(), conversationEntries(listOf(completion(null))))
    }

    @Test
    fun `an ordinary tool event is still not a message`() {
        val tool = AgentEvent(
            id = "t1", kind = "output", summary = "Bash completed",
            detail = "rendered tool call", createdAt = "2026-08-26T10:00:00Z",
            tool = "Bash", subagentId = "aaa",
        )
        assertEquals(emptyList<ConversationEntry>(), conversationEntries(listOf(tool)))
    }
}
