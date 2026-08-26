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
        )

        val sections = latestOf(events)
        assertEquals(listOf("LATEST MESSAGE", "REASONING"), sections.map { it.label })
        assertEquals("newest reply", sections[0].body)
        assertEquals("newest thought", sections[1].body)
    }

    @Test
    fun `leaves out what the session has not produced`() {
        // A session that has only thought shows one section, not two empty ones.
        val sections = latestOf(
            listOf(event("1", "thought", "Reasoning", "2026-08-25T10:00:00Z", detail = "weighing it")),
        )
        assertEquals(listOf("REASONING"), sections.map { it.label })
    }

    @Test
    fun `a shell command is not something a wrist can use`() {
        // The last command used to get a section of its own. A command line is
        // the one thing here a watch can neither read comfortably nor act on.
        val sections = latestOf(
            listOf(event("1", "output", "Bash completed", "2026-08-25T10:00:00Z", command = "bun test")),
        )
        assertEquals(emptyList<LatestSection>(), sections)
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
