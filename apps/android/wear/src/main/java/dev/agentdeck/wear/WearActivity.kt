package dev.agentdeck.wear

import android.app.Application
import android.os.Bundle
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.gestures.ScrollableDefaults
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.PagerState
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
import androidx.compose.ui.res.painterResource
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
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts


class WearActivity : ComponentActivity() {
    companion object {
        /** Which session a notification was about, so tapping it lands there. */
        const val EXTRA_AGENT_ID = "agent_id"
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTheme(android.R.style.Theme_Material_NoActionBar)
        // Asked for on launch, because a watch that cannot buzz is a watch that
        // silently stops being the reason this app exists. Nothing here waits
        // on the answer: a refused permission costs the alerts, not the app.
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // A notification names the session it is about; opening it should not
        // put the person back at the top of a list to find it again.
        setContent { WearTheme { WearDeck(openAgentId = intent?.getStringExtra(EXTRA_AGENT_ID)) } }
    }
}

/**
 * Why a session's history could not be fetched.
 *
 * The two are not the same problem and do not have the same fix. A watch off
 * the network cannot be helped from here; a watch holding a credential the
 * bridge no longer accepts can ask the phone for a new one, and did not,
 * because both failures came out of one boolean reading "could not reach".
 */
internal enum class HistoryFailure { Unreachable, Refused }

/** Control actions that ride the command queue rather than a waiting runtime. */
private val QUEUED_ACTIONS = setOf("pause", "resume", "stop")

/** Enough recent events to hold the newest message, thought and command. */
private const val WATCH_HISTORY_LIMIT = 60

class WearDeckViewModel(application: Application) : AndroidViewModel(application),
    com.google.android.gms.wearable.DataClient.OnDataChangedListener,
    com.google.android.gms.wearable.MessageClient.OnMessageReceivedListener {
    private val preferences = application.getSharedPreferences("bridge", 0)
    private val relayCache = application.getSharedPreferences("relay_cache", 0)
    private val addresses = BridgeAddress(application)
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
        viewModelScope.launch { superviseDirectStream() }
        retryQueuedCommands()
    }

    /**
     * Holds a stream of the watch's own only while the phone is not relaying.
     *
     * The relay is this app's primary source and the direct route its fallback,
     * but the stream was opened unconditionally beside it - and pointed at the
     * `url` the phone synced, which is a tailnet name the watch cannot resolve.
     * So it failed, backed off to its sixteen-second ceiling and retried a host
     * it could never reach, about two hundred times an hour, for as long as the
     * app was alive. Nothing showed, because the relay kept delivering.
     *
     * Now it opens only when the relay has gone quiet, aims at the address that
     * last answered, and waits minutes rather than seconds between attempts.
     */
    private suspend fun superviseDirectStream() {
        var stream: kotlinx.coroutines.Job? = null
        while (true) {
            val relaying = lastRelayAt > 0 &&
                System.currentTimeMillis() - lastRelayAt < RELAY_TRUST_MS
            if (relaying) {
                stream?.cancel()
                stream = null
            } else if (stream?.isActive != true) {
                repository.configure(
                    addresses.candidates(BuildConfig.BRIDGE_URL).first(),
                    SecureTokenStore(getApplication()).get(),
                )
                stream = viewModelScope.launch {
                    repository.stream(maxReconnectDelayMs = WATCH_MAX_RECONNECT_MS)
                }
            }
            delay(RELAY_CHECK_MS)
        }
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

    private val _historyFailed = MutableStateFlow<Pair<String, HistoryFailure>?>(null)

    /** Which session could not be fetched and why, so "empty" is not shown for "refused". */
    internal val historyFailed = _historyFailed.asStateFlow()

    // Explicit return type: this retries by calling itself, and inference
    // cannot chase its own tail.
    fun loadHistory(agentId: String): kotlinx.coroutines.Job = viewModelScope.launch {
        _historyLoading.value = agentId
        _historyFailed.value = null
        // Credentials and the address arrive from the phone after this view
        // model is built, so the client is pointed at them per fetch rather
        // than once at startup - and at whichever address answers, since the
        // phone's route to the bridge is not always the watch's.
        val token = SecureTokenStore(getApplication()).get()
        var loaded = false
        // A credential the bridge refuses is worth telling apart from a bridge
        // that is not there: an empty token counts as refused before a request
        // is even made, because it is one.
        var refused = token.isBlank()
        for (candidate in addresses.candidates(BuildConfig.BRIDGE_URL)) {
            repository.configure(candidate, token)
            // The tail, not the whole session: a long run's full history is
            // most of a megabyte, and only the newest of each is shown here.
            val attempt = runCatching { repository.history(agentId, limit = WATCH_HISTORY_LIMIT) }
            val events = attempt.getOrNull()
            if (events == null) {
                // The client puts the status in the message. Reaching the
                // bridge and being turned away means the address is right and
                // the credential is not, so the other addresses are no help.
                if (attempt.exceptionOrNull()?.message?.contains("401") == true) {
                    refused = true
                    addresses.remember(candidate)
                    break
                }
                continue
            }
            addresses.remember(candidate)
            _sessionEvents.update { it + (agentId to events) }
            loaded = true
            break
        }
        if (!loaded) {
            _historyFailed.value =
                agentId to if (refused) HistoryFailure.Refused else HistoryFailure.Unreachable
            // The phone holds the credential this watch is missing, and sends
            // it on its own only when someone happens to open the phone app.
            // A watch left with a rotated token stayed broken until they did.
            if (refused) {
                sendToPhone(CREDENTIAL_REQUEST_PATH, ByteArray(0)) {}
                // And then use it. The phone answers in a moment; without
                // trying again the fresh credential sat unused until the
                // session was closed and reopened, which made the repair look
                // like it had not worked.
                delay(2_500)
                if (SecureTokenStore(getApplication()).get().let { it.isNotBlank() && it != token }) {
                    _historyLoading.value = null
                    loadHistory(agentId)
                    return@launch
                }
            }
        }
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
        /** Asks the phone to send this watch a fresh bridge credential. */
        const val CREDENTIAL_REQUEST_PATH = "/agent-deck/request-token"

        /**
         * How long a relayed snapshot is taken as proof the phone is still
         * relaying. Comfortably longer than the phone's own cadence, so a
         * quiet deck does not read as a dead relay.
         */
        const val RELAY_TRUST_MS = 3 * 60_000L
        const val RELAY_CHECK_MS = 30_000L
        /** A watch learns nothing by retrying every sixteen seconds. */
        const val WATCH_MAX_RECONNECT_MS = 5 * 60_000L
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
private fun WearDeck(openAgentId: String? = null, vm: WearDeckViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val deliveryError by vm.deliveryError.collectAsStateWithLifecycle()
    val commandNotice by vm.commandNotice.collectAsStateWithLifecycle()
    val sessionEvents by vm.sessionEvents.collectAsStateWithLifecycle()
    val historyLoading by vm.historyLoading.collectAsStateWithLifecycle()
    val historyFailed by vm.historyFailed.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf(openAgentId) }
    val snapshot = when (val current = state) {
        is BridgeState.Ready -> current.snapshot
        is BridgeState.Failed -> current.previous
        BridgeState.Loading -> null
    }
    val selectedAgent = snapshot?.agents?.firstOrNull { it.id == selected }

    // AppScaffold puts the clock over every screen, which is what a watch is
    // for: an app that hides the time is one the user has to leave to check it.
    AppScaffold(timeText = { TimeText() }) {
        // The pager lives out here, and the transition keys on which session
        // is open rather than on the Agent object. A snapshot arrives every few
        // seconds carrying a new Agent, and keying the animation on that object
        // restarted the transition each time - which tore the pages down and
        // put the reader back on the controls mid-read.
        val sessionPager = key(selected) { rememberPagerState(pageCount = { 3 }) }
        AnimatedContent(targetState = selectedAgent?.id, label = "wear-navigation") { openId ->
            val agent = openId?.let { id -> snapshot?.agents?.firstOrNull { it.id == id } }
            if (agent == null) {
                AgentList(snapshot, state, vm::refresh) { selected = it.id }
            } else {
                // Controls, message and reasoning are pages of one session
                // rather than screens to navigate between: a wrist has no room
                // for a tab bar, and a sideways swipe is already how this app
                // moves.
                //
                // No SwipeToDismissBox around them. Wear's claims a horizontal
                // drag in either direction whether or not `userSwipeEnabled`
                // arms it to act on one, so with it in the tree no page could
                // ever be swiped to - which is what made pages look impossible
                // the first time this was tried. Back is the system gesture and
                // the side button, both of which reach BackHandler.
                BackHandler { selected = null }
                val events = sessionEvents[agent.id].orEmpty()
                // Keyed on the live event window as well as the session, so a
                // working session refetches as it works. The transition no
                // longer rebuilds this on every snapshot, and without a second
                // key a single failed fetch would stick for as long as the
                // session stayed open.
                val liveActivity = "${'$'}{agent.events.size}:${'$'}{agent.events.firstOrNull()?.id}"
                LaunchedEffect(agent.id, liveActivity) { vm.loadHistory(agent.id) }
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
                    historyFailure = historyFailed?.takeIf { it.first == agent.id }?.second,
                    pagerState = sessionPager,
                ) { vm.control(agent, it) }
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
                // No connection dot. It was green on every page whenever the
                // app could draw a page at all, so it reported the one state a
                // person can already see. A bridge that cannot be reached says
                // so where it matters instead.
                // Title and count on one line, and smaller than they were.
                // Measured on a 384px round screen, the header ran to y=212 and
                // the first card's text began at y=252 - two thirds of the way
                // down, with one agent visible on a page reporting two. The
                // count is the half worth keeping small: it is the only thing
                // here that says there is more below the fold.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(page.label, color = pageColor, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    // Not on an empty page, where the list says "No paused
                    // agents" directly underneath and a "0" beside the title
                    // only says it again.
                    if (agents.isNotEmpty()) {
                        Text(agents.size.toString(), color = Muted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                Spacer(Modifier.height(4.dp))
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
            // The runtime's own mark, not the state's. Each page of this list
            // already holds one state, so a state icon was identical on every
            // card in view - 32dp of a 192dp screen saying what the page title
            // said. The disc keeps the state colour, so nothing is lost, and
            // the tile next door has always drawn the harness this way.
            val harness = remember(agent.id, agent.name) { Harnesses.of(agent.id, agent.name) }
            Box(Modifier.size(32.dp).clip(CircleShape).background(color.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                val icon = harness.icon
                if (icon != null) {
                    Image(painterResource(icon), harness.label, modifier = Modifier.size(18.dp))
                } else {
                    // A runtime that ships no mark gets its monogram rather
                    // than an empty disc, which would read as a missing icon.
                    Text(harness.mark, color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
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
private fun SessionControls(
    agent: Agent,
    busy: Boolean,
    deliveryError: String?,
    commandNotice: String?,
    onAnswer: (AgentEvent, String) -> Unit,
    sendAction: String?,
    onSend: (String, String) -> Unit,
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
                // "WAITING" over "APPROVAL REQUIRED" says one thing twice, and
                // the row it costs is the one that pushes Approve off the
                // bottom of a 384px screen. The card below carries the colour.
                if (!wantsDecision) {
                    Text(agent.state.uppercase(), color = color, fontSize = 10.sp, letterSpacing = 1.2.sp, fontWeight = FontWeight.Bold)
                }
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
                    // The summary is the question and the detail is the note
                    // explaining it. Reading the detail put the note above the
                    // options and never asked what they were a choice between.
                    pendingQuestion.summary.takeIf { it.isNotBlank() && !it.equals("Question", true) }
                        ?: pendingQuestion.detail.orEmpty(),
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
    }
    }
}

/**
 * One session, as three pages: what you can do, what it said, what it thought.
 *
 * They were stacked vertically, which meant scrolling past every control to
 * reach a sentence - and the controls are what a wrist is for. Pages were
 * turned down once because a plain HorizontalPager fights SwipeToDismissBox for
 * the same drag. Wear's own pager is built for exactly this: it hands the
 * gesture back at the first page, so a swipe right there still leaves the
 * session rather than turning to nothing.
 */
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
    historyFailure: HistoryFailure?,
    pagerState: PagerState,
    onControl: (String) -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
            run {
                when (page) {
                    0 -> SessionControls(
                        agent = agent,
                        busy = busy,
                        deliveryError = deliveryError,
                        commandNotice = commandNotice,
                        onAnswer = onAnswer,
                        sendAction = sendAction,
                        onSend = onSend,
                        onControl = onControl,
                    )
                    1 -> SessionExcerpt(
                        section = latest.firstOrNull { it.label == "LATEST MESSAGE" },
                        empty = "Nothing said yet",
                        historyLoading = historyLoading,
                        historyFailure = historyFailure,
                    )
                    else -> SessionExcerpt(
                        section = latest.firstOrNull { it.label == "REASONING" },
                        empty = "No reasoning shared",
                        historyLoading = historyLoading,
                        historyFailure = historyFailure,
                    )
                }
            }
        }
        // Three pages are only discoverable if something says there are three.
        Row(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            repeat(3) { index ->
                Box(
                    Modifier
                        .size(if (index == pagerState.currentPage) 6.dp else 4.dp)
                        .clip(CircleShape)
                        .background(if (index == pagerState.currentPage) Text else Line),
                )
            }
        }
    }
}

/**
 * A page holding one excerpt, or the reason there is none.
 *
 * Scrollable on its own, because a 500-character excerpt is taller than the
 * screen and the page it sits on no longer scrolls past anything else.
 */
@Composable
private fun SessionExcerpt(
    section: LatestSection?,
    empty: String,
    historyLoading: Boolean,
    historyFailure: HistoryFailure?,
) {
    val scroll = rememberLazyListState()
    val rotary = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { rotary.requestFocus() } }
    val message = when {
        section != null -> null
        historyLoading -> "Loading…"
        // Unreachable, refused and empty all look the same unless each says so.
        // The refused case is the one a person can do something about.
        historyFailure == HistoryFailure.Refused ->
            "This watch's access expired · open Agent Deck on your phone"
        historyFailure == HistoryFailure.Unreachable -> "Could not reach the bridge"
        else -> empty
    }
    LazyColumn(
        state = scroll,
        modifier = Modifier
            .fillMaxSize()
            .background(Ink)
            .rotaryScrollable(RotaryScrollableDefaults.behavior(scroll), focusRequester = rotary),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 40.dp, bottom = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (message != null) {
            item { Text(message, color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center) }
        } else if (section != null) {
            item {
                Text(
                    section.label,
                    color = section.tint,
                    fontSize = 10.sp,
                    letterSpacing = 1.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            item { Text(section.body, fontSize = 13.sp, lineHeight = 18.sp) }
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
