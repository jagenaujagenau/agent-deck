package dev.agentdeck.wear

import android.app.Application
import android.os.Bundle
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.gestures.ScrollableDefaults
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.Surface
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButton
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.OutlinedButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.agentdeck.shared.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import org.json.JSONObject
import java.util.UUID
import dev.agentdeck.shared.agentCardActivity
import dev.agentdeck.shared.supportsCapability
import dev.agentdeck.shared.deliveryNotice
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.material3.SwipeToDismissBox
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import kotlinx.coroutines.flow.update


class WearActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTheme(android.R.style.Theme_Material_NoActionBar)
        setContent { WearTheme { WearDeck() } }
    }
}

/** Control actions that ride the command queue rather than a waiting runtime. */
private val QUEUED_ACTIONS = setOf("pause", "resume", "stop")

/** Enough recent events to hold the newest message, thought and command. */
private const val WATCH_HISTORY_LIMIT = 60

class WearDeckViewModel(application: Application) : AndroidViewModel(application),
    com.google.android.gms.wearable.DataClient.OnDataChangedListener,
    com.google.android.gms.wearable.MessageClient.OnMessageReceivedListener {
    private val preferences = application.getSharedPreferences("bridge", 0)
    private val relayCache = application.getSharedPreferences("relay_cache", 0)
    private val commandOutbox = WearCommandOutbox(application)
    private val repository = AgentRepository(BridgeClient(
        preferences.getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL,
        SecureTokenStore(application).get(),
    ))
    private val dataClient = Wearable.getDataClient(application)
    private val nodeClient = Wearable.getNodeClient(application)
    private val messageClient = Wearable.getMessageClient(application)
    private val json = Json { ignoreUnknownKeys = true }
    private val _state = MutableStateFlow<BridgeState>(BridgeState.Loading)
    val state = _state.asStateFlow()
    private val _busy = MutableStateFlow<String?>(null)
    val busy = _busy.asStateFlow()
    private val _deliveryError = MutableStateFlow<String?>(null)
    val deliveryError = _deliveryError.asStateFlow()
    private val pendingCommands = mutableMapOf<String, String>()
    private var lastRelayAt = relayCache.getLong("publishedAt", 0L)
    private var lastSequence = -1L

    init {
        relayCache.getString("snapshot", null)?.let { acceptSnapshotPayload(it, lastRelayAt) }
        dataClient.addListener(this)
        messageClient.addListener(this)
        dataClient.dataItems.addOnSuccessListener { items ->
            try {
                items.filter { it.uri.path == SNAPSHOT_PATH }.forEach(::acceptSnapshot)
            } finally {
                items.release()
            }
        }
        viewModelScope.launch {
            repository.state.collect { directState ->
                when (directState) {
                    is BridgeState.Ready -> if (WearSnapshotPolicy.shouldApplyDirect(lastSequence, directState.snapshot.sequence, lastRelayAt, System.currentTimeMillis())) {
                        lastSequence = directState.snapshot.sequence
                        _state.value = directState
                    }
                    is BridgeState.Failed -> if (_state.value !is BridgeState.Ready) _state.value = directState
                    BridgeState.Loading -> Unit
                }
            }
        }
        viewModelScope.launch { repository.stream() }
        retryQueuedCommands()
    }

    override fun onDataChanged(events: DataEventBuffer) {
        events.filter { it.type == DataEvent.TYPE_CHANGED && it.dataItem.uri.path == SNAPSHOT_PATH }
            .forEach { acceptSnapshot(it.dataItem) }
    }

    private fun acceptSnapshot(item: com.google.android.gms.wearable.DataItem) {
        val data = DataMapItem.fromDataItem(item).dataMap
        val payload = data.getString("snapshot") ?: return
        acceptSnapshotPayload(payload, data.getLong("publishedAt"))
    }

    private fun acceptSnapshotPayload(payload: String, publishedAt: Long) {
        runCatching { json.decodeFromString(BridgeSnapshot.serializer(), payload) }
            .onSuccess { snapshot ->
                if (!WearSnapshotPolicy.shouldApplyRelay(lastSequence, snapshot.sequence)) return@onSuccess
                lastSequence = snapshot.sequence
                lastRelayAt = publishedAt
                relayCache.edit().putString("snapshot", payload).putLong("publishedAt", lastRelayAt).apply()
                _state.value = BridgeState.Ready(snapshot)
            }
    }

    fun refresh() {
        sendToPhone(REFRESH_PATH, ByteArray(0), fallback = { repository.refresh() })
    }

    private val _sessionEvents = MutableStateFlow<Map<String, List<AgentEvent>>>(emptyMap())

    /**
     * A session's retained history, fetched straight from the bridge.
     *
     * The phone relay carries one event per agent - enough for a status card
     * and nothing like enough for a conversation - so the watch asks the bridge
     * itself. It already holds the credentials the phone synced to it.
     */
    val sessionEvents = _sessionEvents.asStateFlow()

    private val _historyLoading = MutableStateFlow<String?>(null)
    val historyLoading = _historyLoading.asStateFlow()

    private val _historyFailed = MutableStateFlow<String?>(null)

    /** Which session could not be fetched, so "empty" is not shown for "unreachable". */
    val historyFailed = _historyFailed.asStateFlow()

    fun loadHistory(agentId: String) = viewModelScope.launch {
        _historyLoading.value = agentId
        _historyFailed.value = null
        // The watch asks for the tail rather than the whole session: the full
        // history of a long run is most of a megabyte and takes seconds over
        // wifi, and only the newest of each thing is shown here anyway.
        runCatching { repository.history(agentId, limit = WATCH_HISTORY_LIMIT) }
            .onSuccess { events -> _sessionEvents.update { it + (agentId to events) } }
            .onFailure { _historyFailed.value = agentId }
        _historyLoading.value = null
    }

    private val _commandNotice = MutableStateFlow<String?>(null)

    /** What becomes of the last command, when it is not simply collected. */
    val commandNotice = _commandNotice.asStateFlow()

    fun control(agent: Agent, action: String, value: String? = null) {
        val commandId = UUID.randomUUID().toString()
        _busy.value = agent.id
        _deliveryError.value = null
        // An approval is collected by a runtime already blocked waiting for it,
        // so it arrives whatever the session is doing. A pause, resume or stop
        // goes on the same queue a message does, and a session running no turn
        // has nothing to collect it with until it moves.
        _commandNotice.value =
            if (action in QUEUED_ACTIONS || value != null) deliveryNotice(agent.state) else null
        pendingCommands[commandId] = agent.id
        val payloadText = JSONObject()
            .put("commandId", commandId)
            .put("agentId", agent.id)
            .put("action", action)
            .apply { if (value != null) put("value", value) }
            .toString()
        commandOutbox.put(commandId, payloadText)
        val payload = payloadText.toByteArray()
        sendToPhone(
            CONTROL_PATH,
            payload,
            fallback = { repository.control(agent.id, action, value, commandId = commandId) },
        )
        viewModelScope.launch {
            delay(12_000)
            if (pendingCommands.remove(commandId) != null) {
                _busy.value = null
                _deliveryError.value = "Command delivery timed out"
            }
        }
    }

    fun answer(agent: Agent, event: AgentEvent, option: String) {
        val commandId = UUID.randomUUID().toString()
        _busy.value = agent.id
        _deliveryError.value = null
        _commandNotice.value = null
        pendingCommands[commandId] = agent.id
        val question = event.detail ?: event.summary
        val payloadText = JSONObject()
            .put("commandId", commandId).put("agentId", agent.id).put("requestId", event.id)
            .put("question", question).put("answer", option).toString()
        commandOutbox.put(commandId, payloadText)
        sendToPhone(ANSWER_PATH, payloadText.toByteArray(), fallback = { repository.answerQuestion(agent.id, event.id, question, option) })
        viewModelScope.launch {
            delay(12_000)
            if (pendingCommands.remove(commandId) != null) {
                _busy.value = null
                _deliveryError.value = "Answer delivery timed out"
            }
        }
    }

    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != CONTROL_RESULT_PATH) return
        val payload = runCatching { JSONObject(event.data.toString(Charsets.UTF_8)) }.getOrNull() ?: return
        val commandId = payload.optString("commandId")
        val wasPending = pendingCommands.remove(commandId) != null
        if (!wasPending && commandOutbox.all().none { it.id == commandId }) return
        commandOutbox.remove(commandId)
        _busy.value = null
        _deliveryError.value = if (payload.optString("status") == "delivered") null else payload.optString("error", "Command delivery failed")
    }

    private fun retryQueuedCommands() {
        commandOutbox.all().forEach { queued ->
            val payloadText = queued.payload
            val payload = runCatching { JSONObject(payloadText) }.getOrNull() ?: return@forEach
            val commandId = payload.optString("commandId")
            val agentId = payload.optString("agentId")
            if (commandId.isBlank() || agentId.isBlank()) return@forEach
            val requestId = payload.optString("requestId")
            if (requestId.isNotBlank()) {
                pendingCommands[commandId] = agentId
                sendToPhone(ANSWER_PATH, payloadText.toByteArray(), fallback = {
                    repository.answerQuestion(agentId, requestId, payload.optString("question"), payload.optString("answer"))
                })
                return@forEach
            }
            val action = payload.optString("action")
            if (action.isBlank()) return@forEach
            pendingCommands[commandId] = agentId
            sendToPhone(CONTROL_PATH, payloadText.toByteArray(), fallback = { repository.control(agentId, action, commandId = commandId) })
        }
    }

    private fun sendToPhone(path: String, payload: ByteArray, fallback: suspend () -> Unit) {
        val commandId = runCatching { JSONObject(payload.toString(Charsets.UTF_8)).optString("commandId") }.getOrNull()?.takeIf { it.isNotBlank() }
        val runFallback = {
            viewModelScope.launch {
                runCatching { fallback() }
                    .onSuccess {
                        commandId?.let { pendingCommands.remove(it); commandOutbox.remove(it) }
                        _deliveryError.value = null
                    }
                    .onFailure { _deliveryError.value = it.message ?: "Command delivery failed" }
                _busy.value = null
            }
        }
        nodeClient.connectedNodes
            .addOnSuccessListener { nodes ->
                if (nodes.isEmpty()) runFallback()
                else nodes.forEach { messageClient.sendMessage(it.id, path, payload) }
            }
            .addOnFailureListener { runFallback() }
    }

    override fun onCleared() {
        dataClient.removeListener(this)
        messageClient.removeListener(this)
        super.onCleared()
    }

    private companion object {
        const val SNAPSHOT_PATH = "/agent-deck/snapshot"
        const val CONTROL_PATH = "/agent-deck/control"
        const val REFRESH_PATH = "/agent-deck/refresh"
        const val CONTROL_RESULT_PATH = "/agent-deck/control-result"
        const val ANSWER_PATH = "/agent-deck/answer"
    }
}

@Composable
private fun WearTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ColorScheme(
            primary = Signal,
            onPrimary = Ink,
            background = Ink,
            onBackground = Text,
            surfaceContainer = Surface,
            onSurface = Text,
            error = Danger,
        ),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = Ink, contentColor = Text) { content() }
    }
}

@Composable
private fun WearDeck(vm: WearDeckViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val deliveryError by vm.deliveryError.collectAsStateWithLifecycle()
    val commandNotice by vm.commandNotice.collectAsStateWithLifecycle()
    val sessionEvents by vm.sessionEvents.collectAsStateWithLifecycle()
    val historyLoading by vm.historyLoading.collectAsStateWithLifecycle()
    val historyFailed by vm.historyFailed.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<String?>(null) }
    val snapshot = when (val current = state) {
        is BridgeState.Ready -> current.snapshot
        is BridgeState.Failed -> current.previous
        BridgeState.Loading -> null
    }
    val selectedAgent = snapshot?.agents?.firstOrNull { it.id == selected }

    // AppScaffold puts the clock over every screen, which is what a watch is
    // for: an app that hides the time is one the user has to leave to check it.
    AppScaffold(timeText = { TimeText() }) {
        AnimatedContent(targetState = selectedAgent, label = "wear-navigation") { agent ->
            if (agent == null) {
                AgentList(snapshot, state, vm::refresh) { selected = it.id }
            } else {
                // Swiping right is how a watch goes back, everywhere on the
                // platform. The button stays for reachability, not instead.
                SwipeToDismissBox(onDismissed = { selected = null }) { isBackground ->
                    if (isBackground) {
                        Box(Modifier.fillMaxSize().background(Ink))
                    } else {
                        // Controls, reasoning and conversation are pages of one
                        // session rather than screens to navigate between: a
                        // wrist has no room for a tab bar, and a sideways swipe
                        // is already how this app moves.
                        val events = sessionEvents[agent.id].orEmpty()
                        LaunchedEffect(agent.id) { vm.loadHistory(agent.id) }
                        // One vertical screen, not pages. A HorizontalPager
                        // inside SwipeToDismissBox fights it for the same drag,
                        // and with only the latest of each thing to show there
                        // is not enough here to be worth a second page.
                        AgentDetail(
                            agent,
                            busy == agent.id,
                            deliveryError,
                            commandNotice,
                            onAnswer = { event, option -> vm.answer(agent, event, option) },
                            sendAction = remoteMessageAction(agent.state) { action ->
                                supportsCapability(agent.capabilities, action)
                            },
                            onSend = { text, action -> vm.control(agent, action, text) },
                            latest = latestOf(events),
                            historyLoading = historyLoading == agent.id,
                            historyFailed = historyFailed == agent.id,
                        ) { vm.control(agent, it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AgentList(snapshot: BridgeSnapshot?, state: BridgeState, onRefresh: () -> Unit, onAgent: (Agent) -> Unit) {
    if (snapshot == null) {
        Box(Modifier.fillMaxSize().background(Ink).padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (state is BridgeState.Loading) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                else Icon(Icons.Rounded.CloudOff, null, tint = Danger, modifier = Modifier.size(30.dp))
                Text(if (state is BridgeState.Loading) "Connecting" else "Bridge offline", fontWeight = FontWeight.SemiBold)
                TextButton(onClick = onRefresh) { Text("Try again") }
            }
        }
        return
    }

    val pages = WearStatePage.entries
    val pagerState = rememberPagerState(pageCount = { pages.size })
    val pageListStates = pages.map { rememberTransformingLazyColumnState() }
    val pagerFlingBehavior = PagerDefaults.flingBehavior(
        state = pagerState,
        snapAnimationSpec = tween(durationMillis = 160, easing = FastOutSlowInEasing),
        snapPositionalThreshold = 0.35f,
    )
    HorizontalPager(
        state = pagerState,
        modifier = Modifier.fillMaxSize().background(Ink),
        beyondViewportPageCount = 1,
        flingBehavior = pagerFlingBehavior,
    ) { pageIndex ->
        val page = pages[pageIndex]
        val agents = agentsForPage(snapshot.agents, page)
        val pageColor = when (page) {
            WearStatePage.Running -> Signal
            WearStatePage.NeedsYou -> Amber
            WearStatePage.Paused -> Blue
            WearStatePage.Idle -> Muted
        }
        val listState = pageListStates[pageIndex]
        // TransformingLazyColumn scales and fades what approaches the bezel,
        // which is what keeps a round screen readable at its edges. ScreenScaffold
        // draws the scroll indicator beside it.
        ScreenScaffold(scrollState = listState) { contentPadding ->
        val rotaryFocus = remember { FocusRequester() }
        LaunchedEffect(pageIndex, pagerState.currentPage) {
            // Only the page in view should answer the crown; two lists reacting
            // to one turn is worse than none.
            if (pagerState.currentPage == pageIndex) runCatching { rotaryFocus.requestFocus() }
        }
        TransformingLazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .rotaryScrollable(
                    RotaryScrollableDefaults.behavior(listState),
                    focusRequester = rotaryFocus,
                ),
            contentPadding = contentPadding,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          item {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                // The app's own name costs a row the agents need. What the dot
                // says - whether the bridge is reachable - rides with the page
                // title instead, and the clock above already ends the chrome.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(if (state is BridgeState.Ready) Signal else Danger),
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(page.label, color = pageColor, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                }
                Text("${agents.size} ${if (agents.size == 1) "agent" else "agents"}", color = Muted, fontSize = 11.sp)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    pages.indices.forEach { index ->
                        Box(
                            Modifier
                                .size(if (index == pagerState.currentPage) 7.dp else 5.dp)
                                .clip(CircleShape)
                                .background(if (index == pagerState.currentPage) pageColor else Line),
                        )
                    }
                }
                snapshot.agents.flatMap { it.rateLimits }.maxByOrNull { it.usedPercent }?.let { limit ->
                    Spacer(Modifier.height(6.dp))
                    Text("${limit.usedPercent.toInt()}% of ${limit.label} limit", color = if (limit.usedPercent >= 80) Amber else Muted, fontSize = 10.sp)
                }
                Spacer(Modifier.height(2.dp))
            }
          }
          if (agents.isEmpty()) {
            item {
                Box(Modifier.fillMaxWidth().height(112.dp), contentAlignment = Alignment.Center) {
                    Text("No ${page.label.lowercase()} agents", color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center)
                }
            }
          } else {
            agents.groupBy { it.project }.forEach { (project, projectAgents) ->
                item {
                    Text(project, color = Muted, fontSize = 10.sp, modifier = Modifier.padding(start = 10.dp, top = 5.dp))
                }
                items(projectAgents.size) { index ->
                    val agent = projectAgents[index]
                    WearAgentCard(agent, agentLabel(agent.name, project)) { onAgent(agent) }
                }
            }
          }
          item {
            // A wear TextButton lays its content out in a Box, not a Row: an
            // icon beside a label ends up printed over it. The word alone is
            // clearer here anyway.
            TextButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) {
                Text("Refresh", fontSize = 13.sp)
            }
          }
        }
        }
    }
}

@Composable
private fun WearAgentCard(agent: Agent, label: String, onClick: () -> Unit) {
    val color = statusColor(agent.state)
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(24.dp),
        color = Surface,
    ) {
        // A 192dp-wide screen has no room for decoration: the padding, the icon
        // and a chevron together left the name too little space to be read, and
        // a full-width card on a watch already announces that it is tappable.
        Row(Modifier.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(32.dp).clip(CircleShape).background(color.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                Icon(statusIcon(agent.state), null, tint = color, modifier = Modifier.size(17.dp))
            }
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    label,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    agentCardActivity(agent),
                    color = Muted,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun AgentDetail(
    agent: Agent,
    busy: Boolean,
    deliveryError: String?,
    commandNotice: String?,
    onAnswer: (AgentEvent, String) -> Unit,
    sendAction: String?,
    onSend: (String, String) -> Unit,
    latest: List<LatestSection>,
    historyLoading: Boolean,
    historyFailed: Boolean,
    onControl: (String) -> Unit,
) {
    val color = statusColor(agent.state)
    val haptics = LocalHapticFeedback.current
    val supports: (String) -> Boolean = { action -> supportsCapability(agent.capabilities, action) }
    val hasApproval = agent.state == "waiting" && agent.pendingApproval != null
    // Only a question with preset options is answerable from a watch; free-text belongs on the host.
    val pendingQuestion = agent.events
        .filter { it.kind == "question" && it.options.isNotEmpty() }
        .maxByOrNull { it.createdAt }
        ?.takeIf { agent.state == "waiting" }
    val wantsDecision = hasApproval || pendingQuestion != null
    val detailScroll = rememberLazyListState()
    val detailRotary = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { detailRotary.requestFocus() } }
    ScreenScaffold(scrollState = detailScroll) {
    LazyColumn(
        state = detailScroll,
        modifier = Modifier
            .fillMaxSize()
            .background(Ink)
            .rotaryScrollable(
                RotaryScrollableDefaults.behavior(detailScroll),
                focusRequester = detailRotary,
            ),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 26.dp, bottom = 34.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // No status disc. It repeated what the state word beneath it already
        // says, in a colour that word already carries, and cost 64dp of a
        // 384px screen - about one control - on the screen where the controls
        // are the point.
        item {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    agentLabel(agent.name, agent.project),
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                )
                Text(agent.state.uppercase(), color = color, fontSize = 10.sp, letterSpacing = 1.2.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(7.dp))
                if (!wantsDecision) {
                    Text(
                        agentCardActivity(agent),
                        color = Muted,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 3,
                    )
                }
            }
        }
        if (busy) item { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        deliveryError?.let { message ->
            item { Text(message, color = Danger, fontSize = 11.sp, textAlign = TextAlign.Center) }
        }
        if (deliveryError == null) {
            commandNotice?.let { notice ->
                item { Text(notice, color = Muted, fontSize = 11.sp, textAlign = TextAlign.Center) }
            }
        }
        if (hasApproval) {
            // What is being approved, before the button that approves it. A
            // watch is the surface most likely to be tapped without thinking,
            // so it is the last place to ask for a decision without its subject.
            agent.pendingApproval?.let { approval ->
                item {
                    Surface(
                        shape = RoundedCornerShape(18.dp),
                        color = Amber.copy(alpha = 0.12f),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(13.dp)) {
                            Text(
                                "APPROVAL REQUIRED",
                                color = Amber,
                                fontSize = 9.sp,
                                letterSpacing = 1.sp,
                                fontWeight = FontWeight.Bold,
                            )
                            Spacer(Modifier.height(5.dp))
                            Text(approval.tool, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.height(3.dp))
                            Text(approval.detail, color = Text, fontSize = 11.sp, maxLines = 6)
                        }
                    }
                }
            }
            item {
                Button(
                    onClick = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); onControl("approve") },
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    enabled = !busy && supports("approve"),
                ) { Icon(Icons.Rounded.Check, null); Spacer(Modifier.width(6.dp)); Text("Approve") }
            }
            item { OutlinedButton(onClick = { onControl("reject") }, modifier = Modifier.fillMaxWidth().height(48.dp), enabled = !busy && supports("reject")) { Text("Reject") } }
        } else if (pendingQuestion != null) {
            item {
                Text(
                    pendingQuestion.detail ?: pendingQuestion.summary,
                    color = Amber, fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                )
            }
            items(pendingQuestion.options.size) { index ->
                val option = pendingQuestion.options[index]
                Button(
                    onClick = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); onAnswer(pendingQuestion, option) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    enabled = !busy,
                ) { Text(option, fontSize = 13.sp, textAlign = TextAlign.Center, maxLines = 3) }
            }
        } else if (agent.state == "waiting") {
            item { Text("Answer in the agent session", color = Amber, fontSize = 11.sp, textAlign = TextAlign.Center) }
        } else {
            item {
                Button(
                    onClick = { onControl(if (agent.state == "paused") "resume" else "pause") },
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    enabled = !busy && supports(if (agent.state == "paused") "resume" else "pause"),
                ) {
                    Icon(if (agent.state == "paused") Icons.Rounded.PlayArrow else Icons.Rounded.Pause, null, modifier = if (agent.state == "paused") Modifier.offset(x = 1.dp) else Modifier)
                    Spacer(Modifier.width(6.dp)); Text(if (agent.state == "paused") "Resume" else "Pause")
                }
            }
        }
        if (sendAction != null) {
            item {
                WatchComposer(label = "Reply", enabled = !busy) { text -> onSend(text, sendAction) }
            }
        }
        item {
            OutlinedButton(
                onClick = { onControl("stop") },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = !busy && supports("stop"),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger),
            ) { Icon(Icons.Rounded.Stop, null); Spacer(Modifier.width(6.dp)); Text("Stop") }
        }
        // The newest message, thought and command, which is what "what is it
        // doing" actually asks. Fetched from the bridge rather than the phone
        // relay, which carries one event per agent.
        if (latest.isEmpty()) {
            item {
                Text(
                    when {
                        historyLoading -> "Loading…"
                        // Unreachable and empty look the same unless one says so.
                        historyFailed -> "Could not reach the bridge"
                        else -> "Nothing recorded yet"
                    },
                    color = Muted,
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
        items(latest.size) { index ->
            val section = latest[index]
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(18.dp))
                    .background(Surface)
                    .padding(13.dp),
            ) {
                Text(section.label, color = section.tint, fontSize = 9.sp, letterSpacing = 1.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(5.dp))
                Text(section.body, fontSize = 12.sp)
            }
        }
    }
    }
}

private fun statusColor(state: String) = when (state) {
    "running" -> Signal
    "waiting" -> Amber
    "paused" -> Blue
    "error", "offline" -> Danger
    else -> Muted
}

private fun statusIcon(state: String) = when (state) {
    "running" -> Icons.Rounded.Bolt
    "waiting" -> Icons.Rounded.PriorityHigh
    "paused" -> Icons.Rounded.Pause
    "error", "offline" -> Icons.Rounded.CloudOff
    else -> Icons.Rounded.Check
}
