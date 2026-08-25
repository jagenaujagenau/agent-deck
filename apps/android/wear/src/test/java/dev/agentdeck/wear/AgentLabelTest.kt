package dev.agentdeck.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class AgentLabelTest {
    @Test
    fun `drops the project the header shows and the id nobody reads`() {
        assertEquals("Claude", agentLabel("Claude · fx-ruby · 27d9", "fx-ruby"))
    }

    @Test
    fun `keeps a trailing word that is not an id`() {
        // Only a hex stamp is an id; a real word is part of the name.
        assertEquals("Claude · nightly", agentLabel("Claude · fx-ruby · nightly", "fx-ruby"))
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
    fun `a bare id is still dropped when the project is elsewhere`() {
        assertEquals("Codex", agentLabel("Codex · abc1", "other-project"))
    }

    @Test
    fun `an unknown project still loses the id`() {
        assertEquals("Claude · fx-ruby", agentLabel("Claude · fx-ruby · 27d9", ""))
    }
}
