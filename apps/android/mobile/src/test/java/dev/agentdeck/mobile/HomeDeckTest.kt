package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeDeckTest {
    private val now = Instant.parse("2026-08-30T12:00:00Z")

    private fun agent(id: String, state: String, project: String = "deck") = Agent(
        id = id, name = "Claude · $project · $id", project = project, model = "Claude Code",
        state = state, task = "Working", tokens = 0, costUsd = 0.0,
        lastSeenAt = "2026-08-30T11:59:00Z",
    )

    @Test
    fun `states are derived once and views get cards that already know what they are`() {
        val deck = homeDeck(
            listOf(agent("w", "waiting"), agent("r", "running"), agent("e", "error")),
            archivedKeys = emptySet(),
            seenMarks = emptyMap(),
            now = now,
        )
        assertEquals(
            listOf(HomeAgentState.Failed, HomeAgentState.InputRequired, HomeAgentState.Running),
            deck.cards.map { it.state },
        )
        assertEquals(2, deck.attention)
        assertEquals(1, deck.running)
    }

    @Test
    fun `sections group by state then project, in deck order`() {
        val deck = homeDeck(
            listOf(
                agent("r-z", "running", project = "zeta"),
                agent("r-a1", "running", project = "alpha"),
                agent("r-a2", "running", project = "alpha"),
                agent("w", "waiting", project = "zeta"),
            ),
            archivedKeys = emptySet(),
            seenMarks = emptyMap(),
            now = now,
        )
        val sections = deck.sections(HomeFilter.Now)
        assertEquals(listOf(HomeAgentState.InputRequired, HomeAgentState.Running), sections.map { it.state })
        val running = sections.last()
        assertEquals(3, running.count)
        assertEquals(listOf("alpha", "zeta"), running.projects.map { it.project })
        assertEquals(listOf("r-a1", "r-a2"), running.projects.first().cards.map { it.agent.id })
    }

    @Test
    fun `the filter narrows sections and an archived session files under history`() {
        val deck = homeDeck(
            listOf(agent("w", "waiting"), agent("filed", "running")),
            archivedKeys = setOf(agentArchiveKey(agent("filed", "running"))),
            seenMarks = emptyMap(),
            now = now,
        )
        assertEquals(listOf(HomeAgentState.InputRequired), deck.sections(HomeFilter.Now).map { it.state })
        assertEquals(listOf(HomeAgentState.History), deck.sections(HomeFilter.History).map { it.state })
        // Archived-away sessions ask for nothing, whatever their runtime does.
        assertEquals(1, deck.attention)
    }

    @Test
    fun `finished unseen leads the merely running, exactly as the shared ranking says`() {
        val deck = homeDeck(
            listOf(agent("run", "running"), agent("fresh", "idle")),
            archivedKeys = emptySet(),
            seenMarks = emptyMap(),
            now = now,
        )
        assertTrue(deck.cards.first().state == HomeAgentState.Done)
        assertEquals("fresh", deck.cards.first().agent.id)
    }
}
