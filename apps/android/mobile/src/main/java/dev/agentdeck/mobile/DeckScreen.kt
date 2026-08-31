package dev.agentdeck.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*
import kotlinx.coroutines.flow.update

@Composable
internal fun AgentsHeader(deck: HomeDeck, connected: Boolean, bridgeName: String) {
    val attention = deck.attention
    val running = deck.running
    // No "Agents" heading: it named the screen the bottom bar already names,
    // directly above a list of agents. The row it cost now carries the two
    // things that were worth reading - which bridge, and what it is doing.
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(if (connected) Signal else Danger))
        Spacer(Modifier.width(7.dp))
        Text(
            bridgeName,
            fontSize = 13.sp,
            color = Muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Text(" · ", fontSize = 13.sp, color = Muted.copy(alpha = 0.6f))
        Text(
            when {
                attention > 0 && running > 0 -> "$attention need${if (attention == 1) "s" else ""} you · $running running"
                attention > 0 -> "$attention need${if (attention == 1) "s" else ""} you"
                running > 0 -> "$running running"
                else -> "No active work"
            },
            color = if (attention > 0) Amber else Muted,
            fontSize = 13.sp,
            maxLines = 1,
        )
    }
}

/**
 * One session as a chat: who, the last thing said, and when.
 *
 * The deck used to be a dashboard of cards under section headings; a person
 * scanning for "does anything need me" had to read furniture before rows.
 * A chat list answers the same question the way every messaging app has
 * trained a thumb to read it — avatar, name, preview, time, badge — and the
 * session states become the colours of the preview line: amber when the
 * session is asking, signal while it types, quiet when it is done and read.
 */
@Composable
internal fun ChatRow(agent: Agent, homeState: HomeAgentState, busy: Boolean, onClick: () -> Unit) {
    val harness = remember(agent.name) { harnessFor(agent) }
    val statusColor = homeStateColor(homeState)
    // Unread, in this deck's terms: the session wants a person, or finished
    // and nobody has looked. Both earn the bold title and the badge.
    val unread = homeState.attention || homeState == HomeAgentState.Done
    val preview = remember(agent.state, agent.task, agent.objective, agent.pendingApproval, agent.events) {
        chatPreview(agent, homeState)
    }
    val previewColor = when {
        homeState == HomeAgentState.Failed -> Danger
        homeState.attention -> Amber
        // Running, but mute for minutes: amber, not the confident green.
        homeState == HomeAgentState.Running && signalSilenceMinutes(agent) != null -> Amber
        homeState == HomeAgentState.Running -> Signal
        homeState == HomeAgentState.Done -> Text.copy(alpha = 0.87f)
        else -> Muted
    }
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            // Opaque on purpose: the swipe reveal underneath must only show
            // while a swipe is actually uncovering it.
            .background(Ink)
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HarnessMark(harness, running = agent.state == "running", statusColor = statusColor, diameter = 52.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    chatTitle(agent),
                    fontSize = 15.sp,
                    fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold,
                    color = Text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                // The read receipt: finished work someone has already seen.
                if (agent.state == "idle" && !unread) {
                    Icon(Icons.Rounded.DoneAll, "Seen", tint = Blue.copy(alpha = 0.75f), modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(3.dp))
                }
                Text(
                    cardFreshness(latestActivityAt(agent)),
                    color = if (unread) statusColor else Muted,
                    fontSize = 11.sp,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    preview,
                    color = previewColor,
                    fontSize = 13.sp,
                    lineHeight = 17.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                if (busy) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
                } else if (unread) {
                    Box(Modifier.size(9.dp).clip(CircleShape).background(statusColor))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ArchivableAgentCard(agent: Agent, homeState: HomeAgentState, busy: Boolean, archiveEnabled: Boolean, onArchive: () -> Unit, onDismissSession: () -> Unit, onClick: () -> Unit) {
    val content: @Composable () -> Unit = { ChatRow(agent, homeState, busy, onClick) }
    // Only an ended session can be dismissed from the bridge: a live one would
    // reappear on its next heartbeat, which reads as the gesture failing.
    val dismissible = agent.state == "offline"
    if (!archiveEnabled && !dismissible) {
        content()
        return
    }
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when {
                value == SwipeToDismissBoxValue.EndToStart && archiveEnabled -> { onArchive(); true }
                value == SwipeToDismissBoxValue.StartToEnd && dismissible -> { onDismissSession(); true }
                else -> false
            }
        },
    )
    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = dismissible,
        enableDismissFromEndToStart = archiveEnabled,
        backgroundContent = {
            // Archive hides locally, dismiss removes from every surface - the
            // reveal says which one this swipe is before the hand commits.
            if (dismissState.dismissDirection == SwipeToDismissBoxValue.StartToEnd) {
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(Danger.copy(alpha = 0.14f)).padding(start = 22.dp), contentAlignment = Alignment.CenterStart) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.DeleteOutline, "Dismiss", tint = Danger)
                        Spacer(Modifier.width(8.dp))
                        Text("Dismiss", color = Danger, fontWeight = FontWeight.SemiBold)
                    }
                }
            } else {
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(Blue.copy(alpha = 0.14f)).padding(end = 22.dp), contentAlignment = Alignment.CenterEnd) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Archive", color = Blue, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        Icon(Icons.Rounded.Archive, "Archive", tint = Blue)
                    }
                }
            }
        },
    ) { content() }
}

internal fun homeStateColor(state: HomeAgentState) = when {
    state == HomeAgentState.Failed -> Danger
    state.attention -> Amber
    state == HomeAgentState.Running -> Signal
    // The "done" chip: completion's blue, on a full card, until it is read.
    state == HomeAgentState.Done -> Blue
    state == HomeAgentState.RecentlyCompleted -> Blue
    else -> Muted
}

@Composable
internal fun EmptyBridge(state: BridgeState, onConfigure: () -> Unit, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Surface(shape = CircleShape, color = SurfaceRaised) { Icon(Icons.Rounded.Hub, null, tint = Muted, modifier = Modifier.padding(22.dp).size(34.dp)) }
            // A refused credential and an unreachable machine are different
            // problems with different fixes - one wants a fresh pairing code,
            // the other wants the laptop awake. Calling a 401 "out of range"
            // sent people to the wrong one.
            val unauthorized = state is BridgeState.Failed &&
                ("401" in state.message || "403" in state.message || state.message.contains("unauthor", true))
            Text(
                when {
                    state is BridgeState.Loading -> "Finding your agents…"
                    unauthorized -> "This device isn't paired"
                    else -> "Bridge out of range"
                },
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                when {
                    unauthorized -> "The bridge refused this device's token. Enter a fresh pairing code to reconnect."
                    state is BridgeState.Failed -> state.message
                    else -> "Connecting securely over your tailnet"
                },
                color = Muted,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onConfigure) { Text(if (unauthorized) "Pair device" else "Change bridge") }
                Button(onClick = onRetry) { Text("Try again") }
            }
        }
    }
}

@Composable
internal fun OfflineBanner(message: String) {
    Surface(shape = RoundedCornerShape(16.dp), color = Danger.copy(alpha = 0.10f)) {
        Row(Modifier.fillMaxWidth().padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.CloudOff, null, tint = Danger, modifier = Modifier.size(19.dp))
            Spacer(Modifier.width(9.dp))
            Text("Showing last update · $message", color = Danger, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
