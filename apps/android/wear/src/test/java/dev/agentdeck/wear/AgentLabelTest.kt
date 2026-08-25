package dev.agentdeck.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class AgentLabelTest {
    @Test
    fun `drops the project the group header already shows`() {
        assertEquals("Claude · 27d9", agentLabel("Claude · fx-ruby · 27d9", "fx-ruby"))
    }

    @Test
    fun `a name that is only runtime and project keeps the runtime`() {
        assertEquals("Pi", agentLabel("Pi · agent-control-dashboard", "agent-control-dashboard"))
    }

    @Test
    fun `a name that is nothing but the project is left alone`() {
        // Removing everything would leave a card with no label at all.
        assertEquals("fx-ruby", agentLabel("fx-ruby", "fx-ruby"))
    }

    @Test
    fun `a name that does not mention the project is untouched`() {
        assertEquals("Codex · abc1", agentLabel("Codex · abc1", "other-project"))
    }

    @Test
    fun `an unknown project leaves the name alone`() {
        assertEquals("Claude · fx-ruby · 27d9", agentLabel("Claude · fx-ruby · 27d9", ""))
    }
}
