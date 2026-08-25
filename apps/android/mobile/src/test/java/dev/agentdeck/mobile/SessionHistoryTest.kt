package dev.agentdeck.mobile

import dev.agentdeck.shared.AgentEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import dev.agentdeck.shared.ConversationRole
import dev.agentdeck.shared.ConversationEntry
import dev.agentdeck.shared.conversationEntries
import dev.agentdeck.shared.mergeSessionEvents

class SessionHistoryTest {
    private fun event(
        id: String,
        at: String,
        detail: String? = null,
        command: String? = null,
        diff: String? = null,
    ) = AgentEvent(id, "output", "Response", detail, at, command = command, diff = diff)

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
    @Test
    fun `the snapshot's clipped copy does not replace the full message from history`() {
        // The exact failure seen on the phone: a 3337-character reply rendered as its first 400
        // characters, because the snapshot copy of the same event arrived after the history one.
        val full = "Of the three, this one fits best" + " and here is the rest".repeat(40)
        val clipped = full.take(399).trimEnd() + "\u2026"
        val history = listOf(event("a", "2026-08-24T10:00:00Z", detail = full))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", detail = clipped))

        assertEquals(full, mergeSessionEvents(history, live).single().detail)
    }

    @Test
    fun `a revision to shorter text still wins over history`() {
        // Only the clipped shape is restored; a genuinely rewritten event must not be reverted.
        val history = listOf(event("a", "2026-08-24T10:00:00Z", detail = "a much longer earlier text"))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", detail = "short"))

        assertEquals("short", mergeSessionEvents(history, live).single().detail)
    }

    @Test
    fun `text that merely ends in an ellipsis is not treated as clipped`() {
        // An author's own trailing ellipsis is not a clip marker unless history extends it.
        val history = listOf(event("a", "2026-08-24T10:00:00Z", detail = "wait for it\u2026"))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", detail = "wait for it\u2026"))

        assertEquals("wait for it\u2026", mergeSessionEvents(history, live).single().detail)
    }

    @Test
    fun `a terminal command survives the snapshot copy that omits it`() {
        // The snapshot drops `command` to keep cards small. Letting that copy win stripped the
        // command, and the Terminal tab filters on it - so the newest entries vanished from view.
        val history = listOf(event("a", "2026-08-24T10:00:00Z", command = "bun test"))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", command = null))

        val merged = mergeSessionEvents(history, live)
        assertEquals("bun test", merged.single().command)
        assertEquals(listOf("a"), terminalEvents(merged).map { it.id })
    }

    @Test
    fun `a diff survives the snapshot copy that omits it`() {
        val history = listOf(event("a", "2026-08-24T10:00:00Z", diff = "@@ -1 +1 @@"))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", diff = null))

        assertEquals("@@ -1 +1 @@", mergeSessionEvents(history, live).single().diff)
    }

    @Test
    fun `a live command still replaces the one history holds`() {
        // Preserving history must not freeze a value the runtime actually revised.
        val history = listOf(event("a", "2026-08-24T10:00:00Z", command = "old"))
        val live = listOf(event("a", "2026-08-24T10:00:00Z", command = "new"))

        assertEquals("new", mergeSessionEvents(history, live).single().command)
    }

}
