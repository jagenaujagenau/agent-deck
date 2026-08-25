package dev.agentdeck.wear

import androidx.compose.ui.graphics.Color
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.ConversationRole
import dev.agentdeck.shared.conversationEntries
import dev.agentdeck.shared.reasoningEvents

/**
 * How much of one item is worth reading on a wrist before it becomes scrolling.
 * Past this the phone is the right surface, and this says so by ending the
 * excerpt rather than pretending to be a reader.
 */
private const val WATCH_EXCERPT = 500

internal data class LatestSection(val label: String, val body: String, val tint: Color)

/**
 * The newest message, thought and command.
 *
 * Not a conversation: a wrist is consulted rather than read, and these three
 * answer "what is it doing" without any scrolling through history at all.
 */
internal fun latestOf(events: List<AgentEvent>): List<LatestSection> {
    val sections = mutableListOf<LatestSection>()

    conversationEntries(events).lastOrNull { it.role == ConversationRole.Agent }?.let {
        sections += LatestSection("LATEST MESSAGE", it.content.take(WATCH_EXCERPT), Signal)
    }
    reasoningEvents(events).lastOrNull()?.detail?.takeIf { it.isNotBlank() }?.let {
        sections += LatestSection("REASONING", it.take(WATCH_EXCERPT), Blue)
    }
    events.filter { !it.command.isNullOrBlank() }.maxByOrNull { it.createdAt }?.command?.let {
        sections += LatestSection("LAST COMMAND", it.take(WATCH_EXCERPT), Muted)
    }
    return sections
}
