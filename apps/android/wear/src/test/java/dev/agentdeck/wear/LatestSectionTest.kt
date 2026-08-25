package dev.agentdeck.wear

import dev.agentdeck.shared.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class LatestSectionTest {
    private fun event(
        id: String,
        kind: String,
        summary: String,
        at: String,
        detail: String? = null,
        command: String? = null,
    ) = AgentEvent(id, kind, summary, detail, at, command = command)

    @Test
    fun `shows the newest of each, message first`() {
        val events = listOf(
            event("1", "output", "Response", "2026-08-25T10:00:00Z", detail = "older reply"),
            event("2", "thought", "Reasoning", "2026-08-25T10:01:00Z", detail = "older thought"),
            event("3", "output", "Response", "2026-08-25T10:02:00Z", detail = "newest reply"),
            event("4", "thought", "Reasoning", "2026-08-25T10:03:00Z", detail = "newest thought"),
            event("5", "output", "Bash completed", "2026-08-25T10:04:00Z", command = "bun test"),
        )

        val sections = latestOf(events)
        assertEquals(listOf("LATEST MESSAGE", "REASONING", "LAST COMMAND"), sections.map { it.label })
        assertEquals("newest reply", sections[0].body)
        assertEquals("newest thought", sections[1].body)
        assertEquals("bun test", sections[2].body)
    }

    @Test
    fun `leaves out what the session has not produced`() {
        // A session that has only run commands shows one section, not three
        // empty ones.
        val sections = latestOf(
            listOf(event("1", "output", "Bash completed", "2026-08-25T10:00:00Z", command = "ls")),
        )
        assertEquals(listOf("LAST COMMAND"), sections.map { it.label })
    }

    @Test
    fun `an empty session yields nothing to show`() {
        assertEquals(emptyList<LatestSection>(), latestOf(emptyList()))
    }

    @Test
    fun `a long body is cut rather than scrolled`() {
        val long = "x".repeat(2_000)
        val sections = latestOf(listOf(event("1", "output", "Response", "2026-08-25T10:00:00Z", detail = long)))
        assertEquals(500, sections.single().body.length)
    }
}
