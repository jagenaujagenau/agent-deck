package dev.agentdeck.mobile

import dev.agentdeck.shared.Agent
import dev.agentdeck.shared.attentionPriority
import dev.agentdeck.shared.latestActivityAt
import java.time.Instant

/**
 * The home deck, derived once per snapshot instead of once per card per frame.
 *
 * Before this seam existed the home screen asked `homeAgentState` three times
 * per agent per frame, handing it four raw inputs each time — the agent, the
 * archive set, the clock, and the seen marks — so every composable had to
 * know how a presentation state is made. Now the deriving happens here, once,
 * and views take cards that already know what they are. The iOS app's
 * `deckGroups` (HomePolicy.swift) is the same seam in the same place.
 */

/** One session with its presentation already decided. */
internal data class DeckCard(val agent: Agent, val state: HomeAgentState, val seen: Boolean)

/** One project's run inside a section. */
internal data class DeckProjectGroup(val project: String, val cards: List<DeckCard>)

/** One rendered section of the deck: a state and its projects. */
internal data class DeckSection(val state: HomeAgentState, val projects: List<DeckProjectGroup>) {
    val count: Int get() = projects.sumOf { it.cards.size }
}

internal data class HomeDeck(val cards: List<DeckCard>) {
    /** Sessions asking for a person, before any filter narrows the list. */
    val attention: Int get() = cards.count { it.state.attention }
    val running: Int get() = cards.count { it.state == HomeAgentState.Running }

    /**
     * The sections a filter shows: states in section order, projects sorted
     * by name inside each, cards in deck order inside each project.
     */
    fun sections(filter: HomeFilter): List<DeckSection> = cards
        .filter { filter.includes(it.state) }
        .groupBy { it.state }
        .map { (state, stateCards) ->
            DeckSection(
                state = state,
                projects = stateCards.groupBy { it.agent.project }
                    .entries.sortedBy { it.key.lowercase() }
                    .map { DeckProjectGroup(it.key, it.value) },
            )
        }
}

internal fun homeDeck(
    agents: List<Agent>,
    archivedKeys: Set<String>,
    seenMarks: Map<String, String>,
    now: Instant = Instant.now(),
): HomeDeck {
    val cards = agents.map { agent ->
        val seen = agentSeen(agent, seenMarks)
        DeckCard(agent, homeAgentState(agent, agentArchiveKey(agent) in archivedKeys, now, seen), seen)
    }
    // The same order homeAgentOrder produced, on states derived once: sections
    // carry the coarse order, the shared ranking breaks ties within one, and
    // mutable heartbeats never reorder cards while a person reads them.
    // Within the attention states the longest-stuck ask surfaces first —
    // oldest activity on top, not newest — because the session that has been
    // waiting an hour is the one being forgotten. Stable by construction: a
    // waiting session's activity is frozen at the ask that stuck it.
    return HomeDeck(
        cards.sortedWith(
            compareBy<DeckCard> { it.state.ordinal }
                .thenByDescending { attentionPriority(it.agent.state, it.agent.state == "waiting", it.seen) }
                .thenBy { if (it.state.attention) latestActivityAt(it.agent) else "" }
                .thenBy { it.agent.project.lowercase() }
                .thenBy { it.agent.id },
        ),
    )
}
