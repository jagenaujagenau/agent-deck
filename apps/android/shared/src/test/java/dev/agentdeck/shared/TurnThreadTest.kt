package dev.agentdeck.shared

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnThreadTest {
    private fun event(id: String, kind: String = "output", turnId: String? = null) =
        AgentEvent(id = id, kind = kind, summary = "s", createdAt = "2026-08-28T10:00:00Z", turnId = turnId)

    @Test
    fun `a user message always opens an exchange`() {
        assertTrue(startsNewTurn(event("a", turnId = "t1"), event("b", kind = "user", turnId = "t1")))
    }

    @Test
    fun `a turnId change opens one even without a user line`() {
        assertTrue(startsNewTurn(event("a", turnId = "t1"), event("b", turnId = "t2")))
    }

    @Test
    fun `untagged events stay with the thread they follow`() {
        assertFalse(startsNewTurn(event("a", turnId = "t1"), event("b")))
        assertFalse(startsNewTurn(event("a"), event("b", turnId = "t1")))
    }

    @Test
    fun `the same turn never splits`() {
        assertFalse(startsNewTurn(event("a", turnId = "t1"), event("b", turnId = "t1")))
    }
}
