package dev.agentdeck.mobile

import android.os.Build
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*

/**
 * A run of work between words, folded to one quiet line.
 *
 * Collapsed, it says what the run amounted to — "Ran 11 commands, edited
 * 2 files · +190 −11" — because the words around it are what a conversation
 * is for. Tapped, the steps open as a sheet titled with the same sentence;
 * the live run of a working session shows its tail inline, so the work is
 * watchable as it happens without anyone asking.
 */
@Composable
internal fun ActivityCluster(
    events: List<AgentEvent>,
    live: Boolean,
    onOpenSteps: (List<AgentEvent>) -> Unit,
    onOpen: (AgentEvent) -> Unit,
) {
    val tail = if (live) events.takeLast(3) else emptyList()
    Column(Modifier.fillMaxWidth().padding(end = 40.dp)) {
        Row(
            Modifier
                .clip(RoundedCornerShape(9.dp))
                .clickable { onOpenSteps(events) }
                .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Bolt, null, tint = Muted, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(7.dp))
            Text(
                activitySummary(events),
                color = Muted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            diffStat(events)?.let { stat ->
                Spacer(Modifier.width(6.dp))
                DiffStatLabel(stat)
            }
            // Failures ride the summary line so triage needs no expansion.
            failedSteps(events).takeIf { it > 0 }?.let { failed ->
                Spacer(Modifier.width(6.dp))
                Text("$failed failed", color = Danger, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.width(4.dp))
            Icon(Icons.Rounded.ChevronRight, "Open steps", tint = Muted.copy(alpha = 0.7f), modifier = Modifier.size(14.dp))
        }
        if (tail.isNotEmpty()) Row(Modifier.padding(start = 12.dp)) {
            Box(Modifier.width(1.dp).fillMaxHeight().background(Line))
            Column(Modifier.padding(start = 10.dp)) {
                if (events.size > tail.size) {
                    Text(
                        "${events.size - tail.size} earlier steps",
                        color = Muted.copy(alpha = 0.6f),
                        fontSize = 11.sp,
                        modifier = Modifier.padding(vertical = 3.dp),
                    )
                }
                tail.forEach { event -> ActivityRow(event, onOpen) }
            }
        }
    }
}

/** `+190 −11`, in the diff's own colours. */
@Composable
internal fun DiffStatLabel(stat: DiffStat) {
    // Never wraps: "+7 −" over "3" is worse than clipping. A squeezed line
    // yields its neighbours first; the numbers stay whole.
    Row {
        Text("+${stat.added}", color = Signal, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, softWrap = false)
        Spacer(Modifier.width(4.dp))
        Text("−${stat.removed}", color = Danger.copy(alpha = 0.9f), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, softWrap = false)
    }
}

/** Every step of one run, under the sentence that summarised it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StepsSheet(events: List<AgentEvent>, onOpen: (AgentEvent) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 10.dp)) {
                Text(
                    activitySummary(events),
                    color = Text,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                diffStat(events)?.let { DiffStatLabel(it) }
                failedSteps(events).takeIf { it > 0 }?.let { failed ->
                    Spacer(Modifier.width(8.dp))
                    Text("$failed failed", color = Danger, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            // Steps partitioned into who did them: the session's own work
            // reads flat; a subagent's run folds to one titled line, openable
            // into its steps — the same one-more-level the cluster itself is.
            val segments = remember(events) { activitySegments(events) }
            var openSegments by remember(events.firstOrNull()?.id) { mutableStateOf(setOf<String>()) }
            LazyColumn(Modifier.heightIn(max = 560.dp)) {
                segments.forEach { segment ->
                    val segmentKey = segment.events.first().id
                    if (segment.subagentId == null) {
                        items(segment.events, key = { "step:${it.id}" }) { event -> ActivityRow(event, onOpen) }
                    } else {
                        item(key = "segment:$segmentKey") {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(7.dp))
                                    .clickable {
                                        openSegments = if (segmentKey in openSegments) {
                                            openSegments - segmentKey
                                        } else {
                                            openSegments + segmentKey
                                        }
                                    }
                                    .padding(horizontal = 4.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Rounded.Route, null, tint = Blue, modifier = Modifier.size(13.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    segment.title,
                                    color = Blue,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "${segment.events.size} step${if (segment.events.size == 1) "" else "s"}",
                                    color = Muted,
                                    fontSize = 11.sp,
                                )
                                failedSteps(segment.events).takeIf { it > 0 }?.let { failed ->
                                    Spacer(Modifier.width(6.dp))
                                    Text("$failed failed", color = Danger, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                                }
                                Spacer(Modifier.width(5.dp))
                                Icon(
                                    if (segmentKey in openSegments) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                                    null,
                                    tint = Muted.copy(alpha = 0.7f),
                                    modifier = Modifier.size(14.dp),
                                )
                            }
                        }
                        if (segmentKey in openSegments) {
                            items(segment.events, key = { "step:${it.id}" }) { event ->
                                Row {
                                    Spacer(Modifier.width(14.dp))
                                    Box(Modifier.width(1.dp).height(28.dp).background(Line))
                                    Spacer(Modifier.width(8.dp))
                                    Box(Modifier.weight(1f)) { ActivityRow(event, onOpen) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** One step, said as its verb: Ran, Edited, Created, Read — or the thought itself. */
@Composable
internal fun ActivityRow(event: AgentEvent, onOpen: (AgentEvent) -> Unit) {
    val openable = !event.command.isNullOrBlank() || !event.diff.isNullOrBlank() || !event.detail.isNullOrBlank()
    val failed = event.kind == "error"
    val command = event.command?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
    val fileName = event.path?.substringAfterLast('/')
    val verb = when {
        command != null -> "Ran"
        fileName != null && isSearchTool(event.tool) -> "Searched"
        fileName != null && event.tool == "Write" -> "Created"
        fileName != null && event.tool == "Read" -> "Read"
        fileName != null -> "Edited"
        else -> null
    }
    val icon = when {
        event.kind == "thought" -> Icons.Rounded.Psychology
        failed || event.kind == "warning" -> Icons.Rounded.WarningAmber
        command != null -> Icons.Rounded.Terminal
        verb == "Searched" -> Icons.Rounded.Search
        verb == "Created" -> Icons.Rounded.NoteAdd
        verb == "Read" -> Icons.Rounded.Visibility
        verb == "Edited" -> Icons.Rounded.Edit
        else -> Icons.Rounded.Build
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(7.dp))
            .clickable(enabled = openable) { onOpen(event) }
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (failed) Danger else Muted.copy(alpha = 0.8f), modifier = Modifier.size(13.dp))
        Spacer(Modifier.width(8.dp))
        if (verb != null) {
            Text(verb, color = if (failed) Danger else Text.copy(alpha = 0.72f), fontSize = 12.sp)
            Spacer(Modifier.width(6.dp))
            Text(
                command ?: fileName.orEmpty(),
                color = if (failed) Danger else Muted,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (fileName != null) {
                event.diff?.let { diffStat(listOf(event)) }?.let { stat ->
                    Spacer(Modifier.width(6.dp))
                    DiffStatLabel(stat)
                }
            }
        } else {
            // A thought's first words are the row; everything else leads with what it did.
            val line = if (event.kind == "thought") {
                event.detail.orEmpty().lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: event.summary
            } else {
                event.summary
            }
            Text(
                line,
                color = if (failed) Danger else Text.copy(alpha = 0.72f),
                fontSize = 12.sp,
                fontStyle = if (event.kind == "thought") FontStyle.Italic else FontStyle.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        if (openable) {
            Spacer(Modifier.width(5.dp))
            Icon(Icons.Rounded.ChevronRight, null, tint = Muted.copy(alpha = 0.55f), modifier = Modifier.size(13.dp))
        }
    }
}

/** The agent is typing — three quiet dots and what it is on, messaging's own idiom for "working". */
@Composable
internal fun WorkingIndicator(task: String) {
    val transition = rememberInfiniteTransition(label = "working")
    Row(Modifier.padding(start = 6.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { index ->
            val alpha by transition.animateFloat(
                initialValue = 0.25f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(700, delayMillis = index * 160, easing = LinearEasing),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "dot$index",
            )
            Box(Modifier.size(6.dp).clip(CircleShape).background(Signal.copy(alpha = alpha)))
            Spacer(Modifier.width(4.dp))
        }
        Spacer(Modifier.width(7.dp))
        Text(task, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** One step, in full: its command, its words, its diff — depth without leaving the conversation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ActivityDetailSheet(event: AgentEvent, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(event.tool ?: event.summary, color = Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(formatMessageTime(event.createdAt), color = Muted, fontSize = 11.sp)
            }
            if (event.tool != null && event.summary != event.tool) {
                Text(event.summary, color = Muted, fontSize = 12.sp)
            }
            event.command?.takeIf { it.isNotBlank() }?.let { command ->
                Surface(shape = RoundedCornerShape(10.dp), color = Ink) {
                    Text(
                        command,
                        color = Text.copy(alpha = 0.92f),
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                    )
                }
            }
            event.detail?.takeIf { it.isNotBlank() }?.let { detail ->
                if (event.command != null) {
                    Surface(shape = RoundedCornerShape(10.dp), color = Ink) {
                        Text(
                            detail,
                            color = Muted,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                        )
                    }
                } else {
                    Text(detail, color = Text.copy(alpha = 0.88f), fontSize = 14.sp, lineHeight = 21.sp)
                }
            }
            event.diff?.takeIf { it.isNotBlank() }?.let { diff ->
                Surface(shape = RoundedCornerShape(10.dp), color = Ink) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                        diff.lineSequence().forEach { lineText ->
                            Text(
                                lineText,
                                color = when {
                                    lineText.startsWith("+") -> Signal
                                    lineText.startsWith("-") -> Danger.copy(alpha = 0.9f)
                                    lineText.startsWith("@@") -> Blue
                                    else -> Muted
                                },
                                fontSize = 11.sp,
                                lineHeight = 16.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}
