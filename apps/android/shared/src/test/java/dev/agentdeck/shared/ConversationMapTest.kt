package dev.agentdeck.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationMapTest {
    private fun user(id: String, text: String, at: String) = AgentEvent(
        id = id, kind = "user", summary = "Remote command: prompt", detail = text, createdAt = at,
    )

    private fun reply(id: String, text: String, at: String) = AgentEvent(
        id = id, kind = "output", summary = "Response", detail = text, createdAt = at,
    )

    @Test
    fun `one marker per exchange, closed by the reply before the next ask`() {
        val markers = conversationMarkers(
            listOf(
                user("u1", "Fix the tests", "2026-08-31T10:00:00Z"),
                reply("r1", "Working on it", "2026-08-31T10:01:00Z"),
                reply("r2", "All green now", "2026-08-31T10:02:00Z"),
                user("u2", "Now ship it", "2026-08-31T10:03:00Z"),
            ),
        )
        assertEquals(2, markers.size)
        assertEquals("u1", markers[0].id)
        assertEquals("Fix the tests", markers[0].prompt)
        assertEquals("All green now", markers[0].reply)
        assertEquals("u2", markers[1].id)
        assertNull(markers[1].reply)
    }

    @Test
    fun `markdown dressing is stripped and code is named, not quoted`() {
        assertEquals(
            "Use code and run ls in bold",
            markerPreview("Use ```ts\nconst x = 1\n``` and run `ls` in **bold**"),
        )
    }

    @Test
    fun `a long line clips at a word`() {
        val preview = markerPreview("alpha ".repeat(40), limit = 20)
        assertEquals(true, preview.endsWith("…"))
        assertEquals(true, preview.length <= 20)
    }
}
