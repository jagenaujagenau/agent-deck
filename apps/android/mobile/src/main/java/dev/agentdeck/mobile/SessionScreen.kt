package dev.agentdeck.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Toc
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.shared.*
import dev.agentdeck.shared.agentCardActivity
import dev.agentdeck.shared.eventsOfSubagent
import dev.agentdeck.shared.subagentRuns
import dev.agentdeck.shared.supportsCapability
import kotlinx.coroutines.delay

internal fun latestEvent(agent: Agent, predicate: (AgentEvent) -> Boolean = { true }) =
    agent.events.filter(predicate).maxByOrNull { it.createdAt }

@Composable
internal fun AgentSessionView(agent: Agent, busy: Boolean, commandError: String?, commandNotice: String?, commandBlocked: BlockedCommand?, onSendAnyway: () -> Unit, onDismiss: () -> Unit, archived: Boolean, onArchiveToggle: () -> Unit, onControl: (String, String?) -> Unit, onQuestionAnswer: (AgentEvent, String) -> Unit, sessionChanges: List<AgentEvent>, changesLoaded: Boolean, onLoadChanges: () -> Unit, sessionHistory: List<AgentEvent>, onLoadHistory: () -> Unit, slashCommands: List<SlashCommand>, onLoadSlashCommands: () -> Unit, queuedMessages: List<QueuedCommand> = emptyList(), onLoadQueued: () -> Unit = {}, onCancelQueued: (String) -> Unit = {}, seenUpTo: String? = null, models: List<RuntimeModel> = emptyList(), onLoadModels: () -> Unit = {}) {
    // The session is one conversation. Everything the agent did reads inline
    // as work between the words; depth — a command's output, a file's diff,
    // the session's changed files — opens as a sheet over the same screen
    // rather than as somewhere else to be.
    var openActivity by remember(agent.id) { mutableStateOf<AgentEvent?>(null) }
    var openSteps by remember(agent.id) { mutableStateOf<List<AgentEvent>?>(null) }
    var changesOpen by rememberSaveable(agent.id) { mutableStateOf(false) }
    var modelsOpen by rememberSaveable(agent.id) { mutableStateOf(false) }
    var confirmingStop by rememberSaveable(agent.id) { mutableStateOf(false) }
    val supports: (String) -> Boolean = { action -> supportsCapability(agent.capabilities, action) }
    val pendingApproval = (openRequest(agent) as? OpenRequest.Approval)?.approval
    // Tabs show whole histories, so they read the retained history merged with the live window
    // rather than the window alone, which a busy session overflows in minutes.
    val sessionAgent = remember(agent, sessionHistory) {
        val merged = mergeSessionEvents(sessionHistory, agent.events)
        if (merged === agent.events) agent else agent.copy(events = merged)
    }
    // Which subagent is being read, or the whole session when null. A session
    // that farms work out to three subagents reported their tool calls mixed
    // into its own, so "what is it doing" had no answer smaller than all of it.
    var lens by rememberSaveable(agent.id) { mutableStateOf<String?>(null) }
    var lensPickerOpen by rememberSaveable(agent.id) { mutableStateOf(false) }
    val runs = remember(sessionAgent.events) { subagentRuns(sessionAgent.events) }
    // A subagent that has left the retained window is no longer a lens.
    LaunchedEffect(runs, lens) { if (lens != null && runs.none { it.id == lens }) lens = null }
    val activeRun = runs.firstOrNull { it.id == lens }
    // The tabs are handed a session narrowed to one subagent's work, so chat,
    // reasoning, changes and terminal all read as that subagent without a
    // second set of screens existing.
    val viewedAgent = remember(sessionAgent, lens) {
        lens?.let { id -> sessionAgent.copy(events = eventsOfSubagent(sessionAgent.events, id)) }
            ?: sessionAgent
    }
    // What this session is waiting on, asked once — see `openRequest`. An
    // approval outranks a question, so only one card ever shows.
    val open = remember(agent.state, agent.pendingApproval, agent.pendingQuestion, sessionAgent.events) {
        openRequest(sessionAgent)
    }
    val pendingQuestion = (open as? OpenRequest.Question)?.let { question ->
        // The durable Request names its own event id; an event-derived one
        // carries the event itself. Either way the card answers against the
        // event the runtime is parked on.
        question.event ?: latestEvent(sessionAgent) { it.id == question.id }
    }
    // The conversation map and the pick it made; the timeline consumes the
    // pick by scrolling to it once.
    var mapOpen by rememberSaveable(agent.id) { mutableStateOf(false) }
    var mapTarget by remember(agent.id) { mutableStateOf<String?>(null) }
    val markers = remember(viewedAgent.events) { conversationMarkers(viewedAgent.events) }
    val harness = harnessFor(agent)
    val provider = providerFor(agent)
    val stateColor = statusColor(agent.state)
    val activity = remember(agent.state, agent.task, agent.objective, agent.pendingApproval, agent.events) { agentCardActivity(agent) }
    // Prefer the bridge's full history; fall back to whatever the live window still holds while it loads.
    val fileChanges = remember(sessionChanges) { agentFileChanges(sessionChanges) }
    // The current pass: everything since the last instruction. The receipt
    // leads with it, because "what did it just do" is the mid-conversation
    // question the session's grand total buries.
    val instructionAt = remember(viewedAgent.events) { latestInstructionAt(viewedAgent.events) }
    val passChanges = remember(sessionChanges, instructionAt) {
        instructionAt?.let { at -> sessionChanges.filter { it.createdAt > at } }.orEmpty()
    }
    val hasAttention = pendingApproval != null || pendingQuestion != null
    val isPaused = agent.state == "paused"
    // Live events already merge over the fetched history, so a refetch is only needed to recover
    // what has aged out of the snapshot's window since. Keying this on event count would refetch
    // the whole history on every tool call; polling blindly would refetch it for idle sessions
    // that cannot have changed. So: poll slowly, and only spend the fetch when activity moved.
    val liveActivity by rememberUpdatedState("${agent.events.size}:${agent.events.firstOrNull()?.id}")
    LaunchedEffect(agent.id) {
        var fetchedAt = ""
        while (true) {
            if (liveActivity != fetchedAt) {
                onLoadHistory()
                onLoadChanges()
                onLoadQueued()
                fetchedAt = liveActivity
            }
            delay(20_000)
        }
    }
    LaunchedEffect(agent.id) { onLoadSlashCommands() }
    // Only a session the bridge hosts has a list to ask for; the rest answer
    // with nothing and the menu simply does not offer the control.
    LaunchedEffect(agent.id) { if (supports("set_model")) onLoadModels() }
    BackHandler { onDismiss() }

    Surface(Modifier.fillMaxSize(), color = Ink) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Column {
                // Three floating pills rather than a bar: back, who this is,
                // and what can be done to it. The status moved into the middle
                // pill as its second line, which removed an entire row - it was
                // the only thing that row carried besides the buttons now on
                // the right.
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    HeaderPill(shape = CircleShape) {
                        IconButton(onClick = onDismiss, modifier = Modifier.size(44.dp)) {
                            Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back to agents", tint = Text)
                        }
                    }
                    HeaderPill(modifier = Modifier.weight(1f)) {
                        Row(
                            modifier = Modifier
                                // Only tappable when there is something behind
                                // it. A control that opens an empty list is
                                // worse than no control.
                                .then(
                                    if (runs.isEmpty()) Modifier
                                    else Modifier.clickable { lensPickerOpen = true },
                                )
                                .padding(start = 6.dp, end = 12.dp, top = 5.dp, bottom = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            HarnessMark(harness, running = agent.state == "running", statusColor = stateColor, diameter = 42.dp)
                            Spacer(Modifier.width(9.dp))
                            Column(Modifier.weight(1f, fill = false)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        activeRun?.title ?: agent.project,
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        color = if (activeRun != null) Blue else Text,
                                        modifier = Modifier.weight(1f, fill = false),
                                    )
                                    // The session's ledger, worn beside the
                                    // name: what all this work has amounted
                                    // to, one tap from the diffs themselves.
                                    // The receipt in the flow keeps the pass;
                                    // the running total lives here.
                                    if (activeRun == null) {
                                        remember(sessionChanges) { diffStat(sessionChanges) }?.let { stat ->
                                            Box(
                                                Modifier
                                                    .padding(start = 7.dp)
                                                    .clip(RoundedCornerShape(5.dp))
                                                    .clickable { changesOpen = true }
                                                    .padding(horizontal = 2.dp),
                                            ) { DiffStatLabel(stat) }
                                        }
                                    }
                                }
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (activeRun != null) {
                                        // Under a lens the state word belongs
                                        // to the subagent, not the session.
                                        StatusLabel(
                                            if (activeRun.finished) "done" else "running",
                                            if (activeRun.finished) Muted else Blue,
                                        )
                                        Text(" · ", color = Muted.copy(alpha = 0.65f), fontSize = 11.sp)
                                        Text(agent.project, color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    } else {
                                        StatusLabel(agent.state, stateColor)
                                        // A waiting session's activity is already
                                        // named by the banner, or by the card in
                                        // the chat behind it. Repeating it here
                                        // only had room to say "Review requi…".
                                        if (!hasAttention) {
                                            Text(" · ", color = Muted.copy(alpha = 0.65f), fontSize = 11.sp)
                                            Text(activity, color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                }
                            }
                            if (runs.isNotEmpty()) {
                                Spacer(Modifier.width(6.dp))
                                // How many, and that there is something to open.
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Rounded.AccountTree, null, tint = Blue, modifier = Modifier.size(15.dp))
                                    Spacer(Modifier.width(3.dp))
                                    Text(runs.size.toString(), color = Blue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                    Icon(Icons.Rounded.ExpandMore, null, tint = Muted, modifier = Modifier.size(15.dp))
                                }
                            }
                        }
                    }
                    // One button, holding what the row of four used to show:
                    // a header is a place to read, and the actions were
                    // crowding the name that matters. The menu carries them —
                    // map, pause, stop, archive — each exactly as it was.
                    HeaderPill {
                        Box {
                            var actionsOpen by remember { mutableStateOf(false) }
                            IconButton(onClick = { actionsOpen = true }, modifier = Modifier.size(44.dp)) {
                                Icon(Icons.Rounded.MoreVert, "Session actions", tint = Text, modifier = Modifier.size(20.dp))
                            }
                            DropdownMenu(
                                expanded = actionsOpen,
                                onDismissRequest = { actionsOpen = false },
                                containerColor = SurfaceRaised,
                            ) {
                                if (markers.size > 1) DropdownMenuItem(
                                    text = { Text("Conversation map", color = Text, fontSize = 13.sp) },
                                    leadingIcon = { Icon(Icons.AutoMirrored.Rounded.Toc, null, tint = Muted, modifier = Modifier.size(18.dp)) },
                                    onClick = {
                                        actionsOpen = false
                                        mapOpen = true
                                    },
                                )
                                val pauseAction = if (isPaused) "resume" else "pause"
                                if (supports(pauseAction)) DropdownMenuItem(
                                    text = { Text(if (isPaused) "Resume agent" else "Pause agent", color = Text, fontSize = 13.sp) },
                                    leadingIcon = { Icon(if (isPaused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause, null, tint = Muted, modifier = Modifier.size(18.dp)) },
                                    enabled = !busy,
                                    onClick = {
                                        actionsOpen = false
                                        onControl(pauseAction, null)
                                    },
                                )
                                if (supports("stop")) DropdownMenuItem(
                                    text = { Text("Stop agent", color = Danger, fontSize = 13.sp) },
                                    leadingIcon = { Icon(Icons.Rounded.Stop, null, tint = Danger, modifier = Modifier.size(18.dp)) },
                                    enabled = !busy,
                                    onClick = {
                                        actionsOpen = false
                                        confirmingStop = true
                                    },
                                )
                                if (supports("set_model")) DropdownMenuItem(
                                    text = { Text("Model", color = Text, fontSize = 13.sp) },
                                    leadingIcon = { Icon(Icons.Rounded.Tune, null, tint = Muted, modifier = Modifier.size(18.dp)) },
                                    trailingIcon = {
                                        Text(
                                            providerFor(agent).model,
                                            color = Muted,
                                            fontSize = 11.sp,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    },
                                    enabled = !busy,
                                    onClick = {
                                        actionsOpen = false
                                        modelsOpen = true
                                    },
                                )
                                // The ledger again, where the actions live:
                                // the header shows it, the menu opens it.
                                remember(sessionChanges) { diffStat(sessionChanges) }?.let { stat ->
                                    DropdownMenuItem(
                                        text = { Text("Session changes", color = Text, fontSize = 13.sp) },
                                        leadingIcon = { Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(18.dp)) },
                                        trailingIcon = { DiffStatLabel(stat) },
                                        onClick = {
                                            actionsOpen = false
                                            changesOpen = true
                                        },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text(if (archived) "Restore session" else "Archive session", color = Text, fontSize = 13.sp) },
                                    leadingIcon = { Icon(if (archived) Icons.Rounded.Unarchive else Icons.Rounded.Archive, null, tint = Muted, modifier = Modifier.size(18.dp)) },
                                    onClick = {
                                        actionsOpen = false
                                        onArchiveToggle()
                                    },
                                )
                            }
                        }
                    }
                }
            }
            ResponsesView(
                agent = viewedAgent,
                busy = busy,
                pendingApproval = pendingApproval,
                pendingQuestion = pendingQuestion,
                commandError = commandError,
                commandNotice = commandNotice,
                commandBlocked = commandBlocked,
                onSendAnyway = onSendAnyway,
                supports = supports,
                slashCommands = slashCommands,
                onControl = onControl,
                onQuestionAnswer = onQuestionAnswer,
                // Opening a session is a request to read it, not to write to
                // it: the keyboard rises only when the composer is tapped.
                autoFocus = false,
                lensed = activeRun != null,
                onOpenActivity = { openActivity = it },
                onOpenSteps = { openSteps = it },
                changedFiles = fileChanges.size,
                changedStat = remember(sessionChanges) { diffStat(sessionChanges) },
                passFiles = remember(passChanges) { agentFileChanges(passChanges).size },
                passStat = remember(passChanges) { diffStat(passChanges) },
                seenUpTo = seenUpTo,
                onOpenChanges = { changesOpen = true },
                scrollToId = mapTarget,
                onScrolledToMarker = { mapTarget = null },
                queuedMessages = queuedMessages,
                onCancelQueued = onCancelQueued,
                modifier = Modifier.weight(1f),
            )
        }
    }
    openActivity?.let { event ->
        ActivityDetailSheet(event, onDismiss = { openActivity = null })
    }
    openSteps?.let { steps ->
        StepsSheet(
            steps,
            onOpen = { event ->
                openSteps = null
                openActivity = event
            },
            onDismiss = { openSteps = null },
        )
    }
    if (changesOpen) {
        ChangesSheet(fileChanges, changesLoaded, onDismiss = { changesOpen = false })
    }
    if (modelsOpen) {
        ModelPicker(
            models = models,
            current = agent.model,
            onPick = { model ->
                modelsOpen = false
                onControl("set_model", model.id)
            },
            onDismiss = { modelsOpen = false },
        )
    }
    if (mapOpen) {
        ConversationMapSheet(
            markers = markers,
            onPick = { id ->
                mapOpen = false
                mapTarget = id
            },
            onDismiss = { mapOpen = false },
        )
    }
    if (lensPickerOpen) SubagentPicker(
        runs = runs,
        selected = lens,
        onPick = { lens = it; lensPickerOpen = false },
        onDismiss = { lensPickerOpen = false },
    )
    if (confirmingStop) AlertDialog(
        onDismissRequest = { confirmingStop = false },
        icon = { Icon(Icons.Rounded.StopCircle, null, tint = Danger) },
        title = { Text("Stop this session?") },
        text = { Text("The active turn will be interrupted. Output already received will remain available.") },
        confirmButton = {
            Button(
                onClick = {
                    confirmingStop = false
                    onControl("stop", null)
                },
                colors = ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Ink),
            ) { Text("Stop") }
        },
        dismissButton = { TextButton(onClick = { confirmingStop = false }) { Text("Cancel") } },
    )
}

/** One floating piece of the header, lifted off the conversation behind it. */
@Composable
internal fun HeaderPill(
    modifier: Modifier = Modifier,
    shape: Shape = CircleShape,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.shadow(6.dp, shape),
        shape = shape,
        color = SurfaceRaised,
        border = BorderStroke(1.dp, Line),
        content = content,
    )
}

@Composable
internal fun StatusLabel(state: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(state.replaceFirstChar { it.uppercase() }, color = color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

internal fun statusColor(state: String) = when (state) {
    "running" -> Signal
    "waiting" -> Amber
    "paused" -> Blue
    "error", "offline" -> Danger
    else -> Muted
}

internal fun statusIcon(state: String) = when (state) {
    "running" -> Icons.Rounded.Bolt
    "waiting" -> Icons.Rounded.PriorityHigh
    "paused" -> Icons.Rounded.Pause
    "error", "offline" -> Icons.Rounded.CloudOff
    else -> Icons.Rounded.Check
}
