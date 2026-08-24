package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionHistoryTest {
    private fun event(id: String, at: String, detail: String? = null) =
        AgentEvent(id, "output", "Response", detail, at)

    @Test
    fun `history and the live window combine into one ordered timeline`() {
        val history = listOf(event("a", "2026-08-24T10:00:00Z"), event("b", "2026-08-24T10:00:01Z"))
        val live = listOf(event("c", "2026-08-24T10:00:02Z"))

        assertEquals(listOf("a", "b", "c"), mergeSessionEvents(history, live).map { it.id })
    }

    @Test
    fun `the live copy of an event wins, since an event can be revised after publication`() {
        // A tool's diff arrives with its completion, after the event first appeared.
        val history = listOf(event("a", "2026-08-24T10:00:00Z", detail = "before"))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", detail = "after"))

        val merged = mergeSessionEvents(history, live)
        assertEquals(1, merged.size)
        assertEquals("after", merged.single().detail)
    }

    @Test
    fun `an empty history leaves the live window untouched`() {
        val live = listOf(event("a", "2026-08-24T10:00:00Z"))
        assertEquals(live, mergeSessionEvents(emptyList(), live))
    }

    @Test
    fun `conversation survives a window that has overflowed with tool output`() {
        // The exact failure this fixes: a busy session's window holds only tool chatter, while the
        // conversation lives on in the retained history.
        val history = listOf(
            AgentEvent("u1", "user", "Remote command: steer", "fix the tests", "2026-08-24T10:00:00Z"),
            AgentEvent("r1", "output", "Response", "Fixed them.", "2026-08-24T10:00:01Z"),
        )
        val live = (1..5).map { AgentEvent("t$it", "output", "Bash completed", null, "2026-08-24T10:01:0$it", tool = "Bash") }

        val entries = conversationEntries(mergeSessionEvents(history, live))
        assertEquals(listOf(ConversationRole.User, ConversationRole.Agent), entries.map { it.role })
        assertEquals(listOf("fix the tests", "Fixed them."), entries.map { it.content })
        // Derived from the live window alone, the conversation would be empty.
        assertEquals(emptyList<ConversationEntry>(), conversationEntries(live))
    }
}
