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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

private val Ink = Color(0xFF090C10)
private val Surface = Color(0xFF171C22)
private val Line = Color(0xFF303841)
private val Text = Color(0xFFF1F5F4)
private val Muted = Color(0xFF929DA7)
private val Signal = Color(0xFF83E6B2)
private val Amber = Color(0xFFFFC266)
private val Danger = Color(0xFFFF7B7B)
private val Blue = Color(0xFF8CB7FF)

class WearActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTheme(android.R.style.Theme_Material_NoActionBar)
        setContent { WearTheme { WearDeck() } }
    }
}

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

    fun control(agent: Agent, action: String) {
        val commandId = UUID.randomUUID().toString()
        _busy.value = agent.id
        _deliveryError.value = null
        pendingCommands[commandId] = agent.id
        val payloadText = JSONObject().put("commandId", commandId).put("agentId", agent.id).put("action", action).toString()
        commandOutbox.put(commandId, payloadText)
        val payload = payloadText.toByteArray()
        sendToPhone(CONTROL_PATH, payload, fallback = { repository.control(agent.id, action, commandId = commandId) })
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
        colorScheme = darkColorScheme(primary = Signal, onPrimary = Ink, background = Ink, surface = Surface, onSurface = Text, onBackground = Text, error = Danger),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = Ink, contentColor = Text) { content() }
    }
}

@Composable
private fun WearDeck(vm: WearDeckViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val deliveryError by vm.deliveryError.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<String?>(null) }
    val snapshot = when (val current = state) {
        is BridgeState.Ready -> current.snapshot
        is BridgeState.Failed -> current.previous
        BridgeState.Loading -> null
    }
    val selectedAgent = snapshot?.agents?.firstOrNull { it.id == selected }

    AnimatedContent(targetState = selectedAgent, label = "wear-navigation") { agent ->
        if (agent == null) AgentList(snapshot, state, vm::refresh) { selected = it.id }
        else AgentDetail(agent, busy == agent.id, deliveryError, onBack = { selected = null }, onAnswer = { event, option -> vm.answer(agent, event, option) }) { vm.control(agent, it) }
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
    val pageScrollStates = pages.map { rememberScrollState() }
    val listFlingBehavior = rememberFastListFlingBehavior()
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(pageScrollStates[pageIndex], flingBehavior = listFlingBehavior)
                .padding(start = 12.dp, end = 12.dp, top = 28.dp, bottom = 34.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(if (state is BridgeState.Ready) Signal else Danger))
                    Spacer(Modifier.width(6.dp))
                    Text("AGENT DECK", color = Signal, fontSize = 10.sp, letterSpacing = 1.5.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(9.dp))
                Text(page.label, color = pageColor, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                Text("${agents.size} ${if (agents.size == 1) "agent" else "agents"}", color = Muted, fontSize = 11.sp)
                Spacer(Modifier.height(8.dp))
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
                Spacer(Modifier.height(7.dp))
            }
            if (agents.isEmpty()) {
                Box(Modifier.fillMaxWidth().height(112.dp), contentAlignment = Alignment.Center) {
                    Text("No ${page.label.lowercase()} agents", color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center)
                }
            } else {
                agents.groupBy { it.project }.forEach { (project, projectAgents) ->
                    Text(project, color = Muted, fontSize = 10.sp, modifier = Modifier.padding(start = 10.dp, top = 5.dp))
                    projectAgents.forEach { agent -> WearAgentCard(agent) { onAgent(agent) } }
                }
            }
            TextButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Rounded.Refresh, null, Modifier.size(18.dp))
                Spacer(Modifier.width(5.dp))
                Text("Refresh", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun WearAgentCard(agent: Agent, onClick: () -> Unit) {
    val color = statusColor(agent.state)
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(24.dp),
        color = Surface,
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(color.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                Icon(statusIcon(agent.state), null, tint = color, modifier = Modifier.size(19.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(agent.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(agent.task, color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Rounded.ChevronRight, null, tint = Muted, modifier = Modifier.size(18.dp).offset(x = 1.dp))
        }
    }
}

@Composable
private fun AgentDetail(agent: Agent, busy: Boolean, deliveryError: String?, onBack: () -> Unit, onAnswer: (AgentEvent, String) -> Unit, onControl: (String) -> Unit) {
    val color = statusColor(agent.state)
    val haptics = LocalHapticFeedback.current
    val supports: (String) -> Boolean = { action -> agent.capabilities?.contains(action) != false }
    val latest = agent.events.maxByOrNull { it.createdAt }
    val hasApproval = agent.state == "waiting" && agent.pendingApproval != null
    // Only a question with preset options is answerable from a watch; free-text belongs on the host.
    val pendingQuestion = agent.events
        .filter { it.kind == "question" && it.options.isNotEmpty() }
        .maxByOrNull { it.createdAt }
        ?.takeIf { agent.state == "waiting" }
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Ink),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 26.dp, bottom = 34.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            IconButton(onClick = onBack, modifier = Modifier.size(44.dp)) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", tint = Muted, modifier = Modifier.size(20.dp).offset(x = (-1).dp)) }
        }
        item {
            Box(Modifier.size(52.dp).clip(CircleShape).background(color.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                Icon(statusIcon(agent.state), null, tint = color, modifier = Modifier.size(26.dp))
            }
        }
        item {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(agent.name, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                Text(agent.state.uppercase(), color = color, fontSize = 10.sp, letterSpacing = 1.2.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(7.dp))
                Text(agent.task, color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center, maxLines = 3)
            }
        }
        if (busy) item { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        deliveryError?.let { message ->
            item { Text(message, color = Danger, fontSize = 11.sp, textAlign = TextAlign.Center) }
        }
        if (hasApproval) {
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
        item {
            OutlinedButton(
                onClick = { onControl("stop") },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = !busy && supports("stop"),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger),
            ) { Icon(Icons.Rounded.Stop, null); Spacer(Modifier.width(6.dp)); Text("Stop") }
        }
        latest?.let { event ->
            item {
                Surface(shape = RoundedCornerShape(18.dp), color = Surface, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(13.dp)) {
                        Text("LATEST", color = Muted, fontSize = 9.sp, letterSpacing = 1.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(5.dp))
                        Text(event.summary, fontSize = 12.sp, maxLines = 2)
                        event.detail?.let { detail ->
                            Spacer(Modifier.height(4.dp))
                            Text(detail, color = Text, fontSize = 11.sp, maxLines = 4)
                        }
                        if (event.kind == "question") event.options.take(3).forEachIndexed { index, option ->
                            Spacer(Modifier.height(4.dp))
                            Text("${index + 1}. $option", color = Amber, fontSize = 10.sp, maxLines = 2)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun rememberFastListFlingBehavior(): FlingBehavior {
    val platformFling = ScrollableDefaults.flingBehavior()
    return remember(platformFling) {
        object : FlingBehavior {
            override suspend fun ScrollScope.performFling(initialVelocity: Float): Float =
                with(platformFling) { performFling(initialVelocity * 1.3f) }
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
