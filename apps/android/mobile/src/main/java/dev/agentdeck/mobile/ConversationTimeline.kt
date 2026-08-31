package dev.agentdeck.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.MarkdownTypography
import dev.agentdeck.shared.*
import dev.agentdeck.shared.ConversationDays
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

@Composable
internal fun ResponsesView(
    agent: Agent,
    busy: Boolean,
    pendingApproval: PendingApproval?,
    pendingQuestion: AgentEvent?,
    commandError: String?,
    commandNotice: String?,
    commandBlocked: BlockedCommand?,
    onSendAnyway: () -> Unit,
    supports: (String) -> Boolean,
    slashCommands: List<SlashCommand>,
    onControl: (String, String?) -> Unit,
    onQuestionAnswer: (AgentEvent, String) -> Unit,
    autoFocus: Boolean,
    /** Reading one subagent rather than the session. */
    lensed: Boolean = false,
    onOpenActivity: (AgentEvent) -> Unit = {},
    onOpenSteps: (List<AgentEvent>) -> Unit = {},
    changedFiles: Int = 0,
    changedStat: DiffStat? = null,
    /** What the current pass — since the last instruction — touched. */
    passFiles: Int = 0,
    passStat: DiffStat? = null,
    /** Everything newer than this is news to the reader; the divider's mark. */
    seenUpTo: String? = null,
    onOpenChanges: () -> Unit = {},
    /** A conversation-map pick: the timeline scrolls to this event once. */
    scrollToId: String? = null,
    onScrolledToMarker: () -> Unit = {},
    queuedMessages: List<QueuedCommand> = emptyList(),
    onCancelQueued: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val timeline = remember(agent.events) { chatTimeline(agent.events) }
    val entries = timeline
    val working = agent.state == "running"
    // Everything below the timeline in list order: the pending cards, the
    // changed-files line, and the working indicator. Counted once, because the
    // follow-newest maths must agree with what the list actually renders.
    val trailingRows = listOfNotNull(
        pendingQuestion?.id,
        pendingApproval?.id,
        "changes".takeIf { changedFiles > 0 },
        "working".takeIf { working },
    ).size
    val initialLastItem = entries.size + trailingRows - 1
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = initialLastItem.coerceAtLeast(0))
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var followNewest by remember(agent.id) { mutableStateOf(true) }
    var userDragging by remember(agent.id) { mutableStateOf(false) }
    var initialPositionApplied by remember(agent.id) { mutableStateOf(false) }
    var newMessagesWaiting by remember(agent.id) { mutableStateOf(false) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> {
                    userDragging = true
                    followNewest = false
                }
                is DragInteraction.Stop, is DragInteraction.Cancel -> {
                    userDragging = false
                    followNewest = ResponseScrollPolicy.followNewestAfterUserDrag(listState.canScrollForward)
                    if (followNewest) newMessagesWaiting = false
                }
            }
        }
    }
    // A picked marker is a decision to read history: stop following the live
    // edge until the person scrolls back down themselves.
    LaunchedEffect(scrollToId) {
        val id = scrollToId ?: return@LaunchedEffect
        val index = entries.indexOfFirst { it.leadEvent.id == id }
        if (index >= 0) {
            followNewest = false
            listState.animateScrollToItem(index)
        }
        onScrolledToMarker()
    }
    val newest = entries.lastOrNull()
    val newestContentKey = listOf(
        newest?.newestEvent?.id,
        when (newest) {
            is TimelineItem.Message -> newest.entry.content.hashCode()
            is TimelineItem.Activity -> newest.events.size
            null -> null
        },
        pendingQuestion?.id,
        pendingApproval?.id,
        working,
    )
    LaunchedEffect(newestContentKey) {
        val lastItem = entries.size + trailingRows - 1
        if (lastItem < 0) return@LaunchedEffect
        if (!ResponseScrollPolicy.shouldMoveToNewest(initialPositionApplied, followNewest)) {
            newMessagesWaiting = initialPositionApplied
            return@LaunchedEffect
        }
        listState.scrollToEnd(lastItem)
        initialPositionApplied = true
        newMessagesWaiting = false
    }
    LaunchedEffect(listState, entries.size, trailingRows) {
        snapshotFlow { listState.canScrollForward }.distinctUntilChanged().collect { canScrollForward ->
            if (!ResponseScrollPolicy.shouldCorrectLayoutGrowth(initialPositionApplied, followNewest, userDragging, canScrollForward)) return@collect
            val lastItem = entries.size + trailingRows - 1
            if (lastItem >= 0) listState.scrollToEnd(lastItem)
        }
    }
    Column(modifier.background(Ink)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (initialPositionApplied || initialLastItem < 0) 1f else 0f },
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 18.dp),
                // Bottom-aligned, the way every messaging app draws one: a
                // short conversation rests against the composer instead of
                // hanging from the top with a screen of void underneath.
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.Bottom),
            ) {
            if (entries.isEmpty() && pendingApproval == null && pendingQuestion == null) item {
                EmptyConversation(
                    supportsMessaging = listOf("prompt", "steer", "follow_up").any(supports),
                    lensed = lensed,
                )
            }
            val newIndex = firstUnseenIndex(entries, seenUpTo)
            itemsIndexed(entries, key = { _, item -> "item:${item.leadEvent.id}" }) { index, item ->
                // Where the news begins for a returning reader.
                if (index == newIndex) NewDivider()
                // A session open since yesterday reads as one unbroken run, and
                // the stamps only give the hour - "09:14" under "23:47" looks
                // like four minutes, not ten hours.
                ConversationDays
                    .separatorBefore(entries.getOrNull(index - 1)?.newestEvent?.createdAt, item.leadEvent.createdAt)
                    ?.let { DaySeparator(it) }
                // A hairline where a new exchange begins, so a long session
                // reads as threads rather than one unbroken run. The New
                // divider is already a boundary; two lines would say it twice.
                if (index > 0 && index != newIndex && startsNewTurn(entries[index - 1].newestEvent, item.leadEvent)) TurnSeparator()
                when (item) {
                    is TimelineItem.Message -> ConversationBubble(item.entry, providerFor(agent))
                    is TimelineItem.Activity -> ActivityCluster(
                        events = item.events,
                        // The last run of a working session is the one being
                        // written; it arrives open so the work is watchable.
                        live = working && index == entries.lastIndex,
                        onOpenSteps = onOpenSteps,
                        onOpen = onOpenActivity,
                    )
                }
            }
            pendingQuestion?.let { question ->
                item(key = "question:${question.id}") {
                    QuestionCard(question, answerable = question.options.isNotEmpty(), busy = busy) { onQuestionAnswer(question, it) }
                }
            }
                if (pendingApproval != null) item(key = "approval:${pendingApproval.id}") {
                    Surface(shape = RoundedCornerShape(18.dp), color = Amber.copy(alpha = 0.10f), border = BorderStroke(1.dp, Amber.copy(alpha = 0.24f))) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("Approval required", color = Amber, fontWeight = FontWeight.SemiBold)
                            Text(pendingApproval.detail, color = Text.copy(alpha = 0.92f), lineHeight = 21.sp)
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Button(
                                    onClick = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); onControl("approve", null) },
                                    enabled = !busy && supports("approve"),
                                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                                ) { Icon(Icons.Rounded.Check, null); Spacer(Modifier.width(6.dp)); Text("Approve") }
                                OutlinedButton(onClick = { onControl("reject", null) }, enabled = !busy && supports("reject"), modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Reject") }
                            }
                        }
                    }
                }
                if (changedFiles > 0) item(key = "changes") {
                    // The session's receipt: what the work touched, one quiet
                    // line where a conversation would leave one. Mid-
                    // conversation the question is "what did it just do", so
                    // the current pass leads and the session's running total
                    // sits under it — a long-lived session's grand total
                    // would bury the pass that just happened.
                    val passLeads = passFiles > 0 && passFiles != changedFiles
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable(onClick = onOpenChanges)
                            .padding(horizontal = 6.dp, vertical = 6.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(7.dp))
                            Text(
                                if (passLeads) {
                                    "${if (passFiles == 1) "1 file" else "$passFiles files"} changed this pass"
                                } else if (changedFiles == 1) "1 file changed" else "$changedFiles files changed",
                                color = Muted,
                                fontSize = 12.sp,
                            )
                            (if (passLeads) passStat else changedStat)?.let { stat ->
                                Spacer(Modifier.width(7.dp))
                                DiffStatLabel(stat)
                            }
                            Spacer(Modifier.weight(1f))
                            Icon(Icons.Rounded.ChevronRight, null, tint = Muted.copy(alpha = 0.7f), modifier = Modifier.size(16.dp))
                        }
                    }
                }
                if (working) item(key = "working") {
                    // The typing indicator claims live work; over minutes of
                    // silence it shows the silence instead.
                    WorkingIndicator(
                        signalSilenceMinutes(agent)?.let { "No signal for ${it}m" } ?: agent.task,
                    )
                }
            }
            if (newMessagesWaiting) FilledTonalButton(
                onClick = {
                    followNewest = true
                    newMessagesWaiting = false
                    val lastItem = entries.size + trailingRows - 1
                    if (lastItem >= 0) scope.launch { listState.scrollToEnd(lastItem) }
                },
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).heightIn(min = 44.dp),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Icon(Icons.Rounded.ArrowDownward, null, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(7.dp))
                Text("New messages")
            }
        }
        // The composer stays under a lens. A subagent has no inbox - it is
        // spawned with a prompt and returns once, and nothing in the stack can
        // address one: messages are drained per session. So a reply can only
        // go to the session. Hiding the field said "you cannot reply" instead,
        // which is a bigger lie than the one it was avoiding; the placeholder
        // names where the message lands.
        MessageComposer(agent, busy, commandError, commandNotice, commandBlocked, onSendAnyway, supports, slashCommands, onControl, autoFocus, lensed, queuedMessages, onCancelQueued)
    }
}

@Composable
internal fun ConversationBubble(entry: ConversationEntry, provider: ProviderIdentity) {
    val bubbleShape = RoundedCornerShape(
        topStart = 18.dp,
        topEnd = 18.dp,
        bottomStart = if (entry.role == ConversationRole.User) 18.dp else 5.dp,
        bottomEnd = if (entry.role == ConversationRole.User) 5.dp else 18.dp,
    )
    if (entry.role == ConversationRole.User) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            Surface(shape = bubbleShape, color = Signal.copy(alpha = 0.16f), modifier = Modifier.fillMaxWidth(0.84f)) {
                Text(entry.content, color = Text, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp))
            }
            Text(formatMessageTime(entry.event.createdAt), color = Muted.copy(alpha = 0.78f), fontSize = 10.sp, modifier = Modifier.padding(start = 5.dp, end = 5.dp, top = 3.dp))
        }
    } else {
        // A report headline — a background task finishing, a subagent's
        // parting message — is machine-relayed, not the agent freely speaking;
        // the label says which. The wire carries the distinction as a summary
        // that is a real headline instead of "Response".
        val reportLabel = entry.event.summary.takeIf { it != "Response" && it != "Message" }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            ProviderMark(provider, 32.dp)
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                Surface(
                    shape = bubbleShape,
                    color = if (reportLabel != null) Blue.copy(alpha = 0.08f) else SurfaceRaised,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (reportLabel != null) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                Icon(Icons.Rounded.Bolt, null, tint = Blue, modifier = Modifier.size(13.dp))
                                Text(reportLabel, color = Blue, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        MarkdownResponse(entry.content)
                    }
                }
                Text(formatMessageTime(entry.event.createdAt), color = Muted.copy(alpha = 0.78f), fontSize = 10.sp, modifier = Modifier.padding(start = 5.dp, end = 5.dp, top = 3.dp))
            }
        }
    }
}

@Composable
internal fun EmptyConversation(supportsMessaging: Boolean, lensed: Boolean = false) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Rounded.Forum, null, tint = Muted, modifier = Modifier.size(30.dp))
        Text(if (lensed) "This subagent hasn't spoken" else "No responses yet", fontWeight = FontWeight.SemiBold)
        Text(
            when {
                // "Send a message to begin" is not true of a subagent: it is
                // not addressable, and most of them only ever run tools.
                // A running subagent has said nothing yet; a finished one's
                // message arrives with its completion.
                lensed -> "It reports back when it finishes. Its work is under Changes and Terminal."
                supportsMessaging -> "Send a message to begin."
                else -> "This runtime is monitoring-only."
            },
            color = Muted,
            fontSize = 13.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

/** The day a run of messages belongs to, floating over the conversation. */
@Composable
internal fun TurnSeparator() {
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.fillMaxWidth(0.42f).height(1.dp).background(Line))
    }
}

/** Where the news begins for a returning reader — the messaging idiom. */
@Composable
internal fun NewDivider() {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(Signal.copy(alpha = 0.35f)))
        Text(
            "New",
            color = Signal,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.8.sp,
            modifier = Modifier.padding(horizontal = 9.dp),
        )
        Box(Modifier.weight(1f).height(1.dp).background(Signal.copy(alpha = 0.35f)))
    }
}

@Composable
internal fun DaySeparator(label: String) {
    Box(Modifier.fillMaxWidth().padding(bottom = 12.dp), contentAlignment = Alignment.Center) {
        Surface(shape = CircleShape, color = SurfaceRaised, border = BorderStroke(1.dp, Line)) {
            Text(
                label,
                color = Muted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
            )
        }
    }
}

internal val messageTimeFormatter = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

internal fun formatMessageTime(value: String): String = runCatching { messageTimeFormatter.format(Instant.parse(value)) }.getOrDefault(value.substringAfter('T').take(5))

@Composable
internal fun QuestionCard(event: AgentEvent, answerable: Boolean, busy: Boolean, onAnswer: (String) -> Unit) {
    Surface(shape = RoundedCornerShape(18.dp), color = Amber.copy(alpha = 0.10f), border = BorderStroke(1.dp, Amber.copy(alpha = 0.24f))) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Rounded.HelpOutline, null, tint = Amber, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("Agent question", color = Amber, fontWeight = FontWeight.SemiBold)
            }
            // The question first, then the note explaining it. Reading the
            // detail alone showed "Stripe retries are idempotent by key" above
            // three options and never asked what they were choosing between.
            val question = event.summary.takeIf { it.isNotBlank() && !it.equals("Question", true) }
            Text(question ?: event.detail.orEmpty(), lineHeight = 21.sp)
            if (question != null) event.detail?.takeIf { it.isNotBlank() && it != question }?.let {
                Text(it, color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
            }
            event.options.forEachIndexed { index, option ->
                Surface(
                    onClick = { if (answerable && !busy) onAnswer(option) },
                    enabled = answerable && !busy,
                    shape = RoundedCornerShape(12.dp), color = Surface,
                ) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("${index + 1}", color = Amber, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        Spacer(Modifier.width(10.dp))
                        Text(option, color = Text.copy(alpha = 0.9f))
                    }
                }
            }
            Text(if (answerable) "Choose an option to continue this session." else "This question has no preset options — answer from the host terminal.", color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
    }
}

@Composable
internal fun AgentEventCard(event: AgentEvent, expanded: Boolean, onToggle: () -> Unit) {
    val hasDetail = event.detail != null || event.command != null || event.diff != null
    val icon = when {
        event.kind == "question" -> Icons.AutoMirrored.Rounded.HelpOutline
        event.kind == "error" -> Icons.Rounded.ErrorOutline
        event.diff != null || event.tool?.contains("edit", true) == true || event.tool?.contains("write", true) == true -> Icons.Rounded.Difference
        event.command != null || event.tool?.contains("bash", true) == true -> Icons.Rounded.Terminal
        event.path != null -> Icons.Rounded.Description
        event.kind == "thought" -> Icons.Rounded.Psychology
        else -> Icons.Rounded.CheckCircleOutline
    }
    Surface(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable(enabled = hasDetail, onClick = onToggle),
        shape = RoundedCornerShape(16.dp),
        color = Surface,
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(shape = RoundedCornerShape(9.dp), color = eventColor(event.kind).copy(alpha = 0.12f), modifier = Modifier.size(32.dp)) {
                    Box(contentAlignment = Alignment.Center) { Icon(icon, null, tint = eventColor(event.kind), modifier = Modifier.size(17.dp)) }
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(event.summary, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    event.path?.let { Text(it.substringAfterLast('/'), color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                if (hasDetail) Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, if (expanded) "Collapse" else "Expand", tint = Muted, modifier = Modifier.size(18.dp))
            }
            if (expanded) {
                event.command?.let { StructuredCode(it, Blue) }
                event.diff?.let { diff ->
                    Surface(shape = RoundedCornerShape(12.dp), color = Ink) {
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            diff.lines().forEach { line ->
                                Text(line, color = when { line.startsWith("+") -> Signal; line.startsWith("-") -> Danger; else -> Muted }, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 17.sp)
                            }
                        }
                    }
                }
                event.detail?.takeIf { it != event.command }?.let {
                    if (event.kind == "output") MarkdownResponse(it)
                    else Text(it, color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
                }
                if (event.kind == "question") event.options.forEachIndexed { index, option ->
                    Surface(shape = RoundedCornerShape(10.dp), color = Amber.copy(alpha = 0.08f)) {
                        Text("${index + 1}. $option", color = Amber, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp))
                    }
                }
            } else event.detail?.let { Text(it, color = Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
internal fun MarkdownResponse(content: String) {
    val body = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp)
    val typography = markdownTypography(
        h1 = MaterialTheme.typography.headlineSmall.copy(fontSize = 23.sp, lineHeight = 29.sp, fontWeight = FontWeight.SemiBold),
        h2 = MaterialTheme.typography.titleLarge.copy(fontSize = 21.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold),
        h3 = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        h4 = MaterialTheme.typography.titleSmall.copy(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold),
        h5 = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
        h6 = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
        text = body,
        paragraph = body,
        ordered = body,
        bullet = body,
        list = body,
        table = body,
    )
    CompositionLocalProvider(LocalContentColor provides Text.copy(alpha = 0.92f)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            responseBlocks(content).forEach { block ->
                when (block) {
                    is ResponseBlock.Markdown -> Markdown(content = block.content, typography = typography, modifier = Modifier.fillMaxWidth())
                    is ResponseBlock.Table -> MarkdownTable(block, typography)
                }
            }
        }
    }
}

@Composable
internal fun MarkdownTable(table: ResponseBlock.Table, typography: MarkdownTypography) {
    val scrollState = rememberScrollState()
    Surface(shape = RoundedCornerShape(12.dp), color = Ink.copy(alpha = 0.72f), border = BorderStroke(1.dp, Line)) {
        Column(Modifier.fillMaxWidth().horizontalScroll(scrollState)) {
            Row(Modifier.height(IntrinsicSize.Min)) {
                table.headers.forEach { header ->
                    Box(Modifier.width(200.dp).fillMaxHeight().padding(horizontal = 12.dp, vertical = 11.dp), contentAlignment = Alignment.CenterStart) {
                        Text(header, color = Text, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            HorizontalDivider(color = Line)
            table.rows.forEachIndexed { index, row ->
                Row(Modifier.height(IntrinsicSize.Min).background(if (index % 2 == 0) Surface.copy(alpha = 0.45f) else Color.Transparent)) {
                    row.forEach { cell ->
                        Box(Modifier.width(200.dp).fillMaxHeight().padding(horizontal = 12.dp, vertical = 9.dp)) {
                            Markdown(content = cell, typography = typography, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
                if (index != table.rows.lastIndex) HorizontalDivider(color = Line.copy(alpha = 0.7f))
            }
        }
    }
}

@Composable
internal fun StructuredCode(value: String, accent: Color) {
    Surface(shape = RoundedCornerShape(12.dp), color = Ink) {
        Text(value, color = accent, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.fillMaxWidth().padding(12.dp))
    }
}

internal fun eventColor(kind: String) = when (kind) {
    "warning", "question" -> Amber
    "error" -> Danger
    "tool" -> Blue
    else -> Signal
}

internal fun compact(value: Long): String = when {
    value >= 1_000_000 -> "%.1fM".format(value / 1_000_000.0)
    value >= 1_000 -> "%.1fk".format(value / 1_000.0)
    else -> NumberFormat.getIntegerInstance().format(value)
}

internal suspend fun LazyListState.scrollToEnd(lastItem: Int) {
    withFrameNanos { }
    scrollToItem(lastItem)
    scrollBy(Float.MAX_VALUE)
}
