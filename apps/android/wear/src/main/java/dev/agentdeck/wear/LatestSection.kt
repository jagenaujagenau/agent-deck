package dev.agentdeck.wear

import androidx.compose.ui.graphics.Color
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.ConversationRole
import dev.agentdeck.shared.clipAtWord
import dev.agentdeck.shared.conversationEntries
import dev.agentdeck.shared.reasoningEvents
import dev.agentdeck.shared.stripMarkdownForPreview

/**
 * How much of one item is worth reading on a wrist before it becomes scrolling.
 * Past this the phone is the right surface, and this says so by ending the
 * excerpt rather than pretending to be a reader.
 */
private const val WATCH_EXCERPT = 500

internal data class LatestSection(val label: String, val body: String, val tint: Color)

/**
 * The newest message and thought.
 *
 * Not a conversation: a wrist is consulted rather than read, and these two
 * answer "what is it doing" without any scrolling through history at all.
 *
 * The last shell command used to sit here too. It went because a command line
 * is the one thing on this screen a wrist can do nothing with - not read
 * comfortably, not act on, not correct - and it was pushing the controls that
 * matter further down a screen that already could not fit them.
 */
internal fun latestOf(events: List<AgentEvent>): List<LatestSection> =
    listOfNotNull(latestMessage(events), latestReasoning(events))

/** The newest thing the agent said, if it has said anything. */
internal fun latestMessage(events: List<AgentEvent>): LatestSection? =
    conversationEntries(events).lastOrNull { it.role == ConversationRole.Agent }
        ?.let { LatestSection("LATEST MESSAGE", excerpt(it.content), Signal) }

/** The newest thing it was thinking, where the provider shares that at all. */
internal fun latestReasoning(events: List<AgentEvent>): LatestSection? =
    reasoningEvents(events).lastOrNull()?.detail?.takeIf { it.isNotBlank() }
        ?.let { LatestSection("REASONING", excerpt(it), Blue) }

/**
 * A watch-sized excerpt: the Markdown off first, then the clip. Nothing on a
 * wrist renders a table or a fence, so a message that opens with one used to
 * spend the excerpt on punctuation nobody could unfold.
 */
private fun excerpt(value: String): String = clipAtWord(stripMarkdownForPreview(value), WATCH_EXCERPT)
