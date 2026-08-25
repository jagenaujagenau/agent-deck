package dev.agentdeck.wear

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.agentdeck.shared.AgentEvent
import dev.agentdeck.shared.ConversationEntry
import dev.agentdeck.shared.ConversationRole
import dev.agentdeck.shared.conversationEntries
import dev.agentdeck.shared.reasoningEvents

/** How much of a message a wrist is worth reading before it becomes scrolling. */
private const val WATCH_MESSAGE_LIMIT = 700

/**
 * The session's conversation, as the phone shows it and this reads it.
 *
 * Both surfaces derive their entries from the same events, so what a person
 * reads here is what they would read there - shorter, because a wrist is not a
 * screen you dwell on, but never a different conversation.
 */
@Composable
internal fun WatchConversation(
    events: List<AgentEvent>,
    loading: Boolean,
    sendAction: String?,
    busy: Boolean,
    onSend: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val entries = remember(events) { conversationEntries(events) }
    WatchScrollList(
        empty = entries.isEmpty() && sendAction == null,
        loading = loading,
        emptyLabel = "No conversation yet",
        modifier = modifier,
    ) {
        items(entries.size) { index -> ConversationBubble(entries[index]) }
        // A runtime that takes no messages gets no composer, rather than a
        // button that queues something nothing will collect.
        if (sendAction != null) {
            item {
                WatchComposer(label = "Reply", enabled = !busy) { text -> onSend(text, sendAction) }
            }
        }
    }
}

/**
 * What the agent is thinking, newest last.
 *
 * Only a running turn has a train of thought; a finished one has an outcome,
 * which the conversation already carries.
 */
@Composable
internal fun WatchReasoning(events: List<AgentEvent>, loading: Boolean, modifier: Modifier = Modifier) {
    val thoughts = remember(events) { reasoningEvents(events) }
    WatchScrollList(
        empty = thoughts.isEmpty(),
        loading = loading,
        emptyLabel = "No reasoning recorded",
        modifier = modifier,
    ) {
        items(thoughts.size) { index ->
            val thought = thoughts[index]
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 3.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(Surface)
                    .padding(11.dp),
            ) {
                Text(thought.detail.orEmpty().take(WATCH_MESSAGE_LIMIT), fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun ConversationBubble(entry: ConversationEntry) {
    val fromUser = entry.role == ConversationRole.User
    Box(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        contentAlignment = if (fromUser) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .fillMaxWidth(0.94f)
                .clip(RoundedCornerShape(16.dp))
                .background(if (fromUser) Signal.copy(alpha = 0.12f) else Surface)
                .padding(11.dp),
        ) {
            Text(
                entry.content.take(WATCH_MESSAGE_LIMIT),
                fontSize = 12.sp,
                fontWeight = if (fromUser) FontWeight.SemiBold else FontWeight.Normal,
            )
        }
    }
}

/** One scrolling surface, so both views answer the crown and report position alike. */
@Composable
private fun WatchScrollList(
    empty: Boolean,
    loading: Boolean,
    emptyLabel: String,
    modifier: Modifier = Modifier,
    content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit,
) {
    val listState = rememberLazyListState()
    val focus = remember { FocusRequester() }
    ScreenScaffold(scrollState = listState) { contentPadding ->
        if (empty) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (loading) "Loading…" else emptyLabel,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = modifier
                    .fillMaxSize()
                    .rotaryScrollable(RotaryScrollableDefaults.behavior(listState), focusRequester = focus),
                contentPadding = contentPadding,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                content()
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}
