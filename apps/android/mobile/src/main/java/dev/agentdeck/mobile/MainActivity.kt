package dev.agentdeck.mobile

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.MarkdownTypography
import dev.agentdeck.shared.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.roundToInt
import java.text.NumberFormat
import dev.agentdeck.shared.supportsCapability
import dev.agentdeck.shared.agentCardActivity
import dev.agentdeck.shared.deliveryNotice

private val Ink = Color(0xFF090C10)
private val Surface = Color(0xFF11161C)
private val SurfaceRaised = Color(0xFF181E25)
/** Darker than the bar it sits in, so the composer reads as a well. */
private val SurfaceSunken = Color(0xFF0E1319)
private val Line = Color(0xFF252D36)
private val Text = Color(0xFFF2F5F7)
private val Muted = Color(0xFF8D99A6)
private val Signal = Color(0xFF83E6B2)
private val Amber = Color(0xFFFFC266)
private val Danger = Color(0xFFFF7B7B)
private val Blue = Color(0xFF8CB7FF)

class MainActivity : ComponentActivity() {
    private val deckViewModel by viewModels<DeckViewModel>()
    private var targetAgentId by mutableStateOf<String?>(null)
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startBridgeMonitor()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        targetAgentId = intent.data?.takeIf { it.scheme == "agentdeck" && it.host == "agent" }?.lastPathSegment
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            startBridgeMonitor()
        }
        WearCredentialSync.send(this, SecureTokenStore(this).get())
        RecoveryWorkScheduler.schedule(this)
        setContent { AgentDeckTheme { AgentDeckApp(targetAgentId, onTargetConsumed = { targetAgentId = null }, vm = deckViewModel) } }
    }

    override fun onResume() {
        super.onResume()
        deckViewModel.onForeground()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        targetAgentId = intent.data?.takeIf { it.scheme == "agentdeck" && it.host == "agent" }?.lastPathSegment
    }

    private fun startBridgeMonitor() {
        ContextCompat.startForegroundService(this, Intent(this, BridgeMonitorService::class.java))
    }
}

/** Actions that carry words for the model, as opposed to a control decision. */
private val MESSAGE_ACTIONS = setOf("prompt", "steer", "follow_up")

class DeckViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("bridge", 0)
    private val tokenStore = SecureTokenStore(application)
    private val client = BridgeClient(
        preferences.getString("url", BuildConfig.BRIDGE_URL) ?: BuildConfig.BRIDGE_URL,
        tokenStore.get(),
    )
    private val repository = AgentRepository(client)
    val state = repository.state
    private val _commandInFlight = MutableStateFlow<String?>(null)
    val commandInFlight = _commandInFlight.asStateFlow()
    private val _commandError = MutableStateFlow<String?>(null)
    val commandError = _commandError.asStateFlow()
    private val _analyticsState = MutableStateFlow<AnalyticsState>(AnalyticsState.Loading)
    val analyticsState = _analyticsState.asStateFlow()
    private val storedArchivedAgents = preferences.getStringSet("archived_agents", emptySet())?.toSet() ?: emptySet()
    private val _archivedAgents = MutableStateFlow(normalizeArchivedAgentKeys(storedArchivedAgents))
    val archivedAgents = _archivedAgents.asStateFlow()
    private var streamJob: Job? = null

    var bridgeUrl by mutableStateOf(client.baseUrl)
        private set
    init {
        if (_archivedAgents.value != storedArchivedAgents) preferences.edit().putStringSet("archived_agents", _archivedAgents.value).apply()
        startStreaming()
    }

    private fun startStreaming() {
        streamJob?.cancel()
        streamJob = viewModelScope.launch { repository.stream() }
    }

    fun refresh() = viewModelScope.launch { repository.refresh() }

    fun onForeground() {
        repository.wake()
        refresh()
    }

    fun archive(agent: Agent) {
        _archivedAgents.value = _archivedAgents.value + agentArchiveKey(agent)
        preferences.edit().putStringSet("archived_agents", _archivedAgents.value).apply()
        getApplication<Application>().getSystemService(NotificationManager::class.java).cancel(agent.id.hashCode())
    }

    fun restore(agent: Agent) {
        _archivedAgents.value = _archivedAgents.value - agentArchiveKey(agent)
        preferences.edit().putStringSet("archived_agents", _archivedAgents.value).apply()
    }

    fun loadAnalytics(range: String, project: String? = null) = viewModelScope.launch {
        val previous = (_analyticsState.value as? AnalyticsState.Ready)?.data
            ?: (_analyticsState.value as? AnalyticsState.Failed)?.previous
        if (previous == null) _analyticsState.value = AnalyticsState.Loading
        runCatching { client.analytics(range, project) }
            .onSuccess { _analyticsState.value = AnalyticsState.Ready(it) }
            .onFailure { _analyticsState.value = AnalyticsState.Failed(it.message ?: "Usage unavailable", previous) }
    }

    fun saveConnection(url: String, credential: String, onComplete: (Boolean, String?) -> Unit) {
        bridgeUrl = url.trim().trimEnd('/')
        preferences.edit().putString("url", bridgeUrl).apply()
        val value = credential.trim()
        if (value.isBlank()) {
            repository.configure(bridgeUrl, tokenStore.get())
            startStreaming()
            val context = getApplication<Application>()
            ContextCompat.startForegroundService(context, Intent(context, BridgeMonitorService::class.java))
            WearCredentialSync.send(context, tokenStore.get())
            onComplete(true, null)
        } else if (value.matches(Regex("\\d{6}"))) {
            viewModelScope.launch {
                client.configure(bridgeUrl, "")
                runCatching { client.pair(value, "Android phone") }
                    .onSuccess { device ->
                        tokenStore.put(device.token)
                        repository.configure(bridgeUrl, device.token)
                        startStreaming()
                        val context = getApplication<Application>()
                        ContextCompat.startForegroundService(context, Intent(context, BridgeMonitorService::class.java))
                        WearCredentialSync.send(context, device.token)
                        onComplete(true, null)
                    }
                    .onFailure { onComplete(false, it.message ?: "Pairing failed") }
            }
        } else {
            tokenStore.put(value)
            repository.configure(bridgeUrl, value)
            startStreaming()
            WearCredentialSync.send(getApplication(), value)
            onComplete(true, null)
        }
    }

    private val _commandNotice = MutableStateFlow<String?>(null)

    /** What became of the last message: set only when it did not simply go through. */
    val commandNotice = _commandNotice.asStateFlow()

    fun control(agent: Agent, action: String, value: String? = null) = viewModelScope.launch {
        _commandInFlight.value = agent.id
        runCatching { repository.control(agent.id, action, value) }
            .onSuccess {
                _commandError.value = null
                // The bridge accepting a message is not the session receiving
                // it. Say which happened, rather than leaving silence to be
                // read as delivery.
                _commandNotice.value =
                    if (action in MESSAGE_ACTIONS) deliveryNotice(agent.state) else null
            }
            .onFailure {
                _commandError.value = it.message ?: "Command delivery failed"
                _commandNotice.value = null
            }
        _commandInFlight.value = null
    }

    private val _sessionChanges = MutableStateFlow<Map<String, List<AgentEvent>>>(emptyMap())
    val sessionChanges = _sessionChanges.asStateFlow()

    /**
     * The live snapshot only carries a rolling window of events, so a long session's earlier edits
     * are missing from it. The Changes tab asks the bridge for the whole set instead.
     */
    fun loadChanges(agentId: String) = viewModelScope.launch {
        runCatching { repository.changes(agentId) }
            .onSuccess { changes -> _sessionChanges.value = mapOf(agentId to changes) }
    }

    // Keyed by agent but holding only the open one: each entry can be hundreds of events, and
    // accumulating them for every session visited would grow without bound.
    private val _sessionHistory = MutableStateFlow<Map<String, List<AgentEvent>>>(emptyMap())
    val sessionHistory = _sessionHistory.asStateFlow()

    /**
     * The snapshot's rolling window is sized for cards; a busy session pushes its conversation,
     * reasoning and terminal output out of it. The session view reads the retained history instead.
     */
    fun loadHistory(agentId: String) = viewModelScope.launch {
        runCatching { repository.history(agentId) }
            .onSuccess { events -> _sessionHistory.value = mapOf(agentId to events) }
    }

    private val _slashCommands = MutableStateFlow<Map<String, List<SlashCommand>>>(emptyMap())
    val slashCommands = _slashCommands.asStateFlow()

    fun loadSlashCommands(agentId: String) = viewModelScope.launch {
        if (_slashCommands.value.containsKey(agentId)) return@launch
        runCatching { repository.slashCommands(agentId) }
            .onSuccess { commands -> _slashCommands.update { it + (agentId to commands) } }
    }

    fun answerQuestion(agent: Agent, event: AgentEvent, answer: String) = viewModelScope.launch {
        _commandInFlight.value = agent.id
        runCatching { repository.answerQuestion(agent.id, event.id, event.detail ?: event.summary, answer) }
        _commandInFlight.value = null
    }

}

@Composable
private fun AgentDeckTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Signal,
            onPrimary = Ink,
            background = Ink,
            onBackground = Text,
            surface = Surface,
            onSurface = Text,
            surfaceVariant = SurfaceRaised,
            onSurfaceVariant = Muted,
            outline = Line,
            error = Danger,
        ),
        typography = Typography(
            headlineLarge = MaterialTheme.typography.headlineLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp),
            titleLarge = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
            titleMedium = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
            labelLarge = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
        ),
        content = content,
    )
}

private enum class DeckDestination { Agents, Usage }

@Composable
private fun AgentDeckApp(targetAgentId: String? = null, onTargetConsumed: () -> Unit = {}, vm: DeckViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busyAgent by vm.commandInFlight.collectAsStateWithLifecycle()
    val commandError by vm.commandError.collectAsStateWithLifecycle()
    val commandNotice by vm.commandNotice.collectAsStateWithLifecycle()
    val analyticsState by vm.analyticsState.collectAsStateWithLifecycle()
    val archivedAgents by vm.archivedAgents.collectAsStateWithLifecycle()
    var destination by rememberSaveable { mutableStateOf(DeckDestination.Agents) }
    var settingsOpen by remember { mutableStateOf(false) }
    var selectedAgent by remember { mutableStateOf<Agent?>(null) }
    var filter by rememberSaveable { mutableStateOf(HomeFilter.Now) }

    val snapshot = when (val value = state) {
        is BridgeState.Ready -> value.snapshot
        is BridgeState.Failed -> value.previous
        BridgeState.Loading -> null
    }
    LaunchedEffect(targetAgentId, snapshot) {
        if (targetAgentId != null) snapshot?.agents?.firstOrNull { it.id == targetAgentId }?.let {
            selectedAgent = it
            onTargetConsumed()
        }
    }

    val sessionChanges by vm.sessionChanges.collectAsStateWithLifecycle()
    val sessionHistory by vm.sessionHistory.collectAsStateWithLifecycle()
    val slashCommands by vm.slashCommands.collectAsStateWithLifecycle()
    val openAgent = selectedAgent?.let { selected -> snapshot?.agents?.firstOrNull { it.id == selected.id } }
    if (openAgent != null) {
        AgentSessionView(
            agent = openAgent,
            busy = busyAgent == openAgent.id,
            commandError = commandError,
            commandNotice = commandNotice,
            onDismiss = { selectedAgent = null },
            archived = agentArchiveKey(openAgent) in archivedAgents,
            onArchiveToggle = {
                if (agentArchiveKey(openAgent) in archivedAgents) vm.restore(openAgent) else vm.archive(openAgent)
                selectedAgent = null
            },
            onControl = { action, value -> vm.control(openAgent, action, value) },
            onQuestionAnswer = { event, answer -> vm.answerQuestion(openAgent, event, answer) },
            sessionChanges = sessionChanges[openAgent.id].orEmpty(),
            onLoadChanges = { vm.loadChanges(openAgent.id) },
            sessionHistory = sessionHistory[openAgent.id].orEmpty(),
            onLoadHistory = { vm.loadHistory(openAgent.id) },
            slashCommands = slashCommands[openAgent.id].orEmpty(),
            onLoadSlashCommands = { vm.loadSlashCommands(openAgent.id) },
        )
        return
    }

    Scaffold(
        containerColor = Ink,
        topBar = {
            DeckTopBar(
                connected = state is BridgeState.Ready,
                bridgeName = when {
                    snapshot == null -> "Bridge offline"
                    vm.bridgeUrl.startsWith("https://") -> "Secure tailnet"
                    else -> snapshot.bridge.name
                },
                onSettings = { settingsOpen = true },
                onRefresh = vm::refresh,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize()) {
        if (destination == DeckDestination.Usage) {
            AnalyticsScreen(
                state = analyticsState,
                onLoad = vm::loadAnalytics,
                modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
            )
        } else Box(
            modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
        ) {
            val data = snapshot
            if (data == null) {
                EmptyBridge(state = state, onConfigure = { settingsOpen = true }, onRetry = vm::refresh)
            } else {
                val boardAgents = unarchivedAgents(data.agents, archivedAgents)
                val homeNow = Instant.now()
                val filtered = homeAgentOrder(
                    data.agents.filter { agent -> filter.includes(homeAgentState(agent, agentArchiveKey(agent) in archivedAgents, homeNow)) },
                    archivedAgents,
                    homeNow,
                )
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = DeckNavSpace),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item { AgentsHeader(boardAgents, homeNow) }
                    item {
                        Row(
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val attention = boardAgents.count { homeAgentState(it, now = homeNow).attention }
                            HomeFilter.entries.forEach { item ->
                                FilterChip(
                                    selected = filter == item,
                                    onClick = { filter = item },
                                    label = { Text(item.label) },
                                    leadingIcon = if (item == HomeFilter.Attention && attention > 0) {
                                        { Text(attention.toString(), fontWeight = FontWeight.Bold) }
                                    } else null,
                                )
                            }
                        }
                    }
                    if (state is BridgeState.Failed) {
                        item { OfflineBanner((state as BridgeState.Failed).message) }
                    }
                    HomeAgentState.entries.forEach { homeState ->
                        val stateAgents = filtered.filter { homeAgentState(it, agentArchiveKey(it) in archivedAgents, homeNow) == homeState }
                        if (stateAgents.isNotEmpty()) {
                            item(key = "state:${homeState.name}") { HomeStateHeader(homeState, stateAgents.size) }
                            stateAgents.groupBy { it.project }.entries.sortedBy { it.key.lowercase() }.forEach { (projectName, agents) ->
                                item(key = "${homeState.name}:project:$projectName") { ProjectGroupHeader(projectName, agents, showAttention = false) }
                                items(agents, key = { "${homeState.name}:${it.id}" }) { agent ->
                                    ArchivableAgentCard(
                                        agent = agent,
                                        homeState = homeState,
                                        busy = busyAgent == agent.id,
                                        archiveEnabled = filter != HomeFilter.History,
                                        onArchive = { vm.archive(agent) },
                                        onClick = { selectedAgent = agent },
                                    )
                                }
                            }
                        }
                    }
                    if (filtered.isEmpty()) {
                        item { Text("No agents in this view", color = Muted, modifier = Modifier.padding(vertical = 32.dp)) }
                    }
                }
            }
        }
        DeckBottomBar(destination, onSelect = { destination = it }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }

    if (settingsOpen) {
        ConnectionDialog(vm.bridgeUrl, onDismiss = { settingsOpen = false }) { url, credential, onResult ->
            vm.saveConnection(url, credential) { success, error ->
                onResult(success, error)
                if (success) settingsOpen = false
            }
        }
    }
}

/** Room a scrolling screen leaves so its last item can clear the floating bar. */
private val DeckNavSpace = 104.dp

@Composable
private fun DeckBottomBar(selected: DeckDestination, onSelect: (DeckDestination) -> Unit, modifier: Modifier = Modifier) {
    // A floating capsule rather than a full-width bar: content keeps running underneath it, which
    // reads as one continuous surface instead of a screen cut in two.
    Surface(
        modifier = modifier.navigationBarsPadding().padding(horizontal = 28.dp, vertical = 12.dp),
        shape = CircleShape,
        color = SurfaceRaised.copy(alpha = 0.94f),
        border = BorderStroke(1.dp, Line.copy(alpha = 0.7f)),
        shadowElevation = 12.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DeckNavItem(Icons.Rounded.Bolt, "Agents", selected == DeckDestination.Agents) { onSelect(DeckDestination.Agents) }
            DeckNavItem(Icons.Rounded.Insights, "Usage", selected == DeckDestination.Usage) { onSelect(DeckDestination.Usage) }
        }
    }
}

@Composable
private fun DeckNavItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    // The selected pill and its colour cross-fade together, so switching tabs reads as one move.
    val tint by animateColorAsState(if (selected) Signal else Muted, tween(180), label = "nav-tint")
    val pill by animateColorAsState(
        if (selected) Signal.copy(alpha = 0.14f) else Color.Transparent,
        tween(180),
        label = "nav-pill",
    )
    Surface(
        modifier = Modifier.clip(CircleShape).clickable(onClick = onClick),
        shape = CircleShape,
        color = pill,
    ) {
        Row(
            // A minimum width keeps the capsule from resizing as the selection moves between labels.
            modifier = Modifier.widthIn(min = 104.dp).heightIn(min = 48.dp).padding(horizontal = 18.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                label,
                color = tint,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
            )
        }
    }
}

private enum class AnalyticsRange(val api: String, val label: String, val days: Long) {
    Day("day", "Day", 1), Week("week", "Week", 7), Month("month", "Month", 30),
    Quarter("quarter", "Quarter", 90), Year("year", "Year", 365),
}

@Composable
private fun AnalyticsScreen(
    state: AnalyticsState,
    onLoad: (String, String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var range by rememberSaveable { mutableStateOf(AnalyticsRange.Month) }
    var project by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(range, project) { onLoad(range.api, project) }
    val data = when (state) {
        is AnalyticsState.Ready -> state.data
        is AnalyticsState.Failed -> state.previous
        AnalyticsState.Loading -> null
    }

    if (data == null) {
        Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            if (state is AnalyticsState.Failed) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Rounded.QueryStats, null, tint = Danger, modifier = Modifier.size(32.dp))
                    Text("Usage unavailable", fontWeight = FontWeight.SemiBold)
                    Text(state.message, color = Muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    TextButton(onClick = { onLoad(range.api, project) }) { Text("Try again") }
                }
            } else {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(4) { Box(Modifier.fillMaxWidth().height(if (it == 0) 130.dp else 72.dp).clip(RoundedCornerShape(20.dp)).background(SurfaceRaised)) }
                }
            }
        }
        return
    }

    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 18.dp, bottom = DeckNavSpace),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Usage", style = MaterialTheme.typography.headlineLarge)
                Text("Agent activity and spend across ${range.label.lowercase()}", color = Muted)
            }
        }
        item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AnalyticsRange.entries.forEach { item ->
                    FilterChip(selected = range == item, onClick = { range = item }, label = { Text(item.label) })
                }
            }
        }
        if (data.filters.projects.isNotEmpty()) item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = project == null, onClick = { project = null }, label = { Text("All projects") })
                data.filters.projects.forEach { name ->
                    FilterChip(selected = project == name, onClick = { project = name }, label = { Text(name, maxLines = 1) })
                }
            }
        }
        item { UsageSummary(data.summary) }
        if (data.limits.isNotEmpty()) item { RateLimitSection(data.limits) }
        item { ActivityHeatmap(data.heatmap, range) }
        item { UsageTrend(data.series, range) }
        if (data.projects.isNotEmpty()) {
            item { SectionLabel("By project") }
            items(data.projects, key = { it.project }) { item -> ProjectUsageRow(item, data.summary.tokens) }
        }
        if (data.runtimes.isNotEmpty()) {
            item { SectionLabel("By runtime") }
            item {
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    data.runtimes.forEach { item -> RuntimeUsageCard(item) }
                }
            }
        }
        if (state is AnalyticsState.Failed) item { OfflineBanner(state.message) }
    }
}

@Composable
private fun UsageSummary(summary: AnalyticsSummary) {
    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f)) {
                    Text("PRICED COST", color = Muted, fontSize = 11.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
                    Text(formatMoney(summary.costUsd), fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.SemiBold, color = Amber)
                    if (summary.costCoveragePercent < 99.9) Text("${summary.costCoveragePercent.toInt()}% token coverage · ${formatCompact(summary.unpricedTokens)} unpriced", color = Muted, fontSize = 11.sp)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("TOKENS", color = Muted, fontSize = 11.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
                    Text(formatCompact(summary.tokens), fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Blue)
                }
            }
            HorizontalDivider(color = Muted.copy(alpha = 0.16f))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                SmallMetric("Sessions", summary.sessions.toString())
                SmallMetric("Events", summary.events.toString())
                SmallMetric("Active days", summary.activeDays.toString())
            }
            val facets = summary.tokenFacets
            if (facets.uncachedInput + facets.cachedInput + facets.cacheCreation + facets.output > 0) {
                HorizontalDivider(color = Muted.copy(alpha = 0.16f))
                Text("TOKEN MIX", color = Muted, fontSize = 11.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    SmallMetric("Input", formatCompact(facets.uncachedInput))
                    SmallMetric("Cache read", formatCompact(facets.cachedInput))
                    SmallMetric("Cache write", formatCompact(facets.cacheCreation))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    SmallMetric("Output", formatCompact(facets.output))
                    SmallMetric("Reasoning*", formatCompact(facets.reasoning))
                    SmallMetric("Covered", formatCompact(facets.uncachedInput + facets.cachedInput + facets.cacheCreation + facets.output))
                }
                Text("* Reasoning is included in output totals.", color = Muted, fontSize = 10.sp)
            }
        }
    }
}

@Composable
private fun SmallMetric(label: String, value: String) {
    Column {
        Text(value, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(label, color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun RateLimitSection(limits: List<RateLimitWindow>) {
    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Rate limits", style = MaterialTheme.typography.titleMedium)
                Text("Live provider windows", color = Muted, fontSize = 12.sp)
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                limits.forEach { limit -> RateLimitRing(limit) }
            }
        }
    }
}

@Composable
private fun RateLimitRing(limit: RateLimitWindow) {
    val used = (limit.usedPercent / 100.0).toFloat().coerceIn(0f, 1f)
    val color = when { used >= 0.9f -> Danger; used >= 0.7f -> Amber; else -> Signal }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.width(82.dp)) {
        Box(Modifier.size(68.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(progress = { used }, modifier = Modifier.fillMaxSize(), color = color, trackColor = Line, strokeWidth = 6.dp)
            Text("${limit.usedPercent.toInt()}%", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        }
        Text(limit.label, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        Text(limit.runtime?.replaceFirstChar { it.uppercase() } ?: limit.account ?: "Provider", color = Muted, fontSize = 10.sp, maxLines = 1)
    }
}

@Composable
private fun ActivityHeatmap(days: List<ActivityDay>, range: AnalyticsRange) {
    val today = remember { LocalDate.now(ZoneOffset.UTC) }
    val start = remember(range, today) { today.minusDays(range.days - 1).with(java.time.DayOfWeek.SUNDAY) }
    val end = remember(today) { today.plusDays((7 - today.dayOfWeek.value).toLong() % 7) }
    val values = remember(days) { days.associateBy { it.date } }
    val dates = remember(start, end) { generateSequence(start) { it.plusDays(1) }.takeWhile { !it.isAfter(end) }.toList() }
    val weeks = remember(dates) { dates.chunked(7) }
    val maxActivity = (days.maxOfOrNull { it.count } ?: 0).coerceAtLeast(1)
    var selected by remember { mutableStateOf<ActivityDay?>(null) }
    val scroll = rememberScrollState()
    LaunchedEffect(weeks.size) { withFrameNanos { }; scroll.scrollTo(scroll.maxValue) }

    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Activity", style = MaterialTheme.typography.titleMedium)
                Text("${days.sumOf { it.count }} events", color = Muted, fontSize = 12.sp)
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                weeks.forEach { week ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        week.forEach { date ->
                            val day = values[date.toString()]
                            val level = if (day == null || day.count == 0) 0f else (day.count.toFloat() / maxActivity).coerceIn(0.2f, 1f)
                            Box(
                                Modifier.size(13.dp).clip(RoundedCornerShape(3.dp))
                                    .background(if (level == 0f) Muted.copy(alpha = 0.12f) else Signal.copy(alpha = 0.25f + level * 0.75f))
                                    .clickable(enabled = day != null) { selected = day },
                            )
                        }
                    }
                }
            }
            selected?.let { day ->
                Text("${day.date}  ·  ${day.count} events  ·  ${formatCompact(day.tokens)} tokens  ·  ${formatMoney(day.costUsd)}", color = Muted, fontSize = 12.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("Less", color = Muted, fontSize = 10.sp)
                listOf(0.12f, 0.35f, 0.55f, 0.75f, 1f).forEach { alpha ->
                    Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (alpha == 0.12f) Muted.copy(alpha = alpha) else Signal.copy(alpha = alpha)))
                }
                Text("More", color = Muted, fontSize = 10.sp)
            }
        }
    }
}

@Composable
private fun UsageTrend(points: List<AnalyticsPoint>, range: AnalyticsRange) {
    val maxTokens = (points.maxOfOrNull { it.tokens } ?: 0L).coerceAtLeast(1L)
    Surface(shape = RoundedCornerShape(24.dp), color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Token trend", style = MaterialTheme.typography.titleMedium)
                Text(if (range == AnalyticsRange.Year) "Monthly" else if (range == AnalyticsRange.Quarter) "Weekly" else "Daily", color = Muted, fontSize = 12.sp)
            }
            if (points.isEmpty()) Text("Usage will appear after agents report new token deltas.", color = Muted)
            else Row(
                Modifier.fillMaxWidth().height(100.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                points.forEach { point ->
                    val height = ceil(point.tokens.toDouble() / maxTokens * 88).toInt().coerceAtLeast(4)
                    Box(Modifier.width(14.dp).height(height.dp).clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)).background(Blue.copy(alpha = 0.82f)))
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, color = Muted, fontSize = 12.sp, letterSpacing = 1.sp, fontWeight = FontWeight.Bold)
}

@Composable
private fun ProjectUsageRow(item: ProjectUsage, totalTokens: Long) {
    val share = if (totalTokens <= 0) 0f else item.tokens.toFloat() / totalTokens
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(item.project, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${item.sessions} sessions · ${item.events} events", color = Muted, fontSize = 12.sp)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(formatCompact(item.tokens), color = Blue, fontWeight = FontWeight.SemiBold)
                Text(formatMoney(item.costUsd), color = Muted, fontSize = 12.sp)
            }
        }
        LinearProgressIndicator(
            progress = { share.coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().height(4.dp).clip(CircleShape),
            color = Signal,
            trackColor = Muted.copy(alpha = 0.12f),
        )
    }
}

@Composable
private fun RuntimeUsageCard(item: RuntimeUsage) {
    Surface(shape = RoundedCornerShape(18.dp), color = Surface, modifier = Modifier.width(150.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(item.runtime.replaceFirstChar { it.uppercase() }, color = Muted, fontSize = 12.sp)
            Text(formatCompact(item.tokens), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Blue)
            Text("${formatMoney(item.costUsd)} · ${item.events} events", color = Muted, fontSize = 11.sp)
        }
    }
}

private fun formatCompact(value: Long): String = when {
    value >= 1_000_000_000 -> String.format("%.1fB", value / 1_000_000_000.0)
    value >= 1_000_000 -> String.format("%.1fM", value / 1_000_000.0)
    value >= 1_000 -> String.format("%.1fK", value / 1_000.0)
    else -> value.toString()
}.replace(".0", "")

private fun formatMoney(value: Double): String = if (value < 0.01 && value > 0) "<$0.01" else String.format("$%.2f", value)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeckTopBar(connected: Boolean, bridgeName: String, onSettings: () -> Unit, onRefresh: () -> Unit) {
    TopAppBar(
        title = {
            Column {
                Text("AGENT DECK", fontSize = 12.sp, letterSpacing = 2.sp, fontWeight = FontWeight.Bold, color = Signal)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(if (connected) Signal else Danger))
                    Spacer(Modifier.width(7.dp))
                    Text(bridgeName, fontSize = 13.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        },
        actions = {
            IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, "Refresh") }
            IconButton(onClick = onSettings) { Icon(Icons.Rounded.Tune, "Bridge settings") }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Ink.copy(alpha = 0.96f)),
        windowInsets = WindowInsets.statusBars,
    )
}

@Composable
private fun AgentsHeader(agents: List<Agent>, now: Instant) {
    val attention = agents.count { homeAgentState(it, now = now).attention }
    val running = agents.count { homeAgentState(it, now = now) == HomeAgentState.Running }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text("Agents", style = MaterialTheme.typography.headlineLarge)
        Text(
            when {
                attention > 0 && running > 0 -> "$attention need${if (attention == 1) "s" else ""} you · $running running"
                attention > 0 -> "$attention need${if (attention == 1) "s" else ""} you"
                running > 0 -> "$running running"
                else -> "No active work"
            },
            color = if (attention > 0) Amber else Muted,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun HomeStateHeader(state: HomeAgentState, count: Int) {
    val color = when {
        state == HomeAgentState.Failed -> Danger
        state.attention -> Amber
        state == HomeAgentState.Running -> Signal
        state == HomeAgentState.RecentlyCompleted -> Blue
        else -> Muted
    }
    Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 1.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(state.sectionLabel, color = color, fontSize = 10.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        Text(count.toString(), color = Muted, fontSize = 11.sp)
    }
}

private enum class AgentHarness(val label: String, val color: Color) {
    Pi("Pi", Blue), Claude("Claude Code", Color(0xFFD97757)), Codex("Codex", Text), Other("Agent", Muted),
}

private data class ProviderIdentity(val name: String, val model: String, val color: Color)

private fun harnessFor(agent: Agent) = when {
    agent.name.startsWith("Pi", ignoreCase = true) -> AgentHarness.Pi
    agent.name.startsWith("Claude", ignoreCase = true) -> AgentHarness.Claude
    agent.name.startsWith("Codex", ignoreCase = true) -> AgentHarness.Codex
    else -> AgentHarness.Other
}

private fun providerFor(agent: Agent): ProviderIdentity {
    val raw = agent.model.substringAfterLast('/').trim()
    val provider = when {
        agent.model.contains("claude", true) || agent.model.equals("Claude Code", true) -> Triple("Anthropic", Color(0xFFD97757), "Anthropic")
        agent.model.contains("gemini", true) -> Triple("Google", Color(0xFF78A7FF), "Google")
        agent.model.contains("grok", true) -> Triple("xAI", Text, "xAI")
        agent.model.contains("gpt", true) || agent.model.contains("openai", true) || harnessFor(agent) == AgentHarness.Codex -> Triple("OpenAI", Signal, "OpenAI")
        else -> Triple("Provider", Muted, "Model unavailable")
    }
    val model = when {
        raw.equals("Claude Code", true) -> provider.third
        raw.startsWith("claude-", true) -> humanizeModelId(raw.removePrefix("claude-"))
        raw.startsWith("gpt-", true) -> "GPT-${humanizeModelId(raw.removePrefix("gpt-"))}"
        raw.isBlank() -> provider.third
        else -> raw
    }
    return ProviderIdentity(provider.first, model, provider.second)
}

private fun sessionSuffix(agent: Agent): String {
    val suffix = agent.name.substringAfterLast('·', "").trim()
    return if (suffix.matches(Regex("[a-fA-F0-9]{4}"))) " · $suffix" else ""
}

private fun latestEvent(agent: Agent, predicate: (AgentEvent) -> Boolean = { true }) =
    agent.events.filter(predicate).maxByOrNull { it.createdAt }

private fun usefulTask(agent: Agent): String {
    if (agent.state == "waiting") {
        agent.pendingApproval?.let { return "Approval · ${it.detail}" }
        val latest = latestEvent(agent) { it.kind == "question" }
        if (latest != null) return latest.detail?.let { "Question · $it" } ?: "Agent has a question"
        return agent.task
    }
    if (agent.state == "running" || agent.state == "paused") {
        val receivedInstruction = latestEvent(agent) {
            it.kind == "thought" && it.summary == "Received instruction" && !it.detail.isNullOrBlank()
        }?.detail
        val objective = agent.objective?.takeIf { it.isNotBlank() } ?: receivedInstruction
        if (!objective.isNullOrBlank()) return objective
    }
    if (agent.state == "offline") {
        val response = latestEvent(agent) { it.kind == "output" && it.summary == "Response" && !it.detail.isNullOrBlank() }
        return response?.detail?.let { "Last response · $it" } ?: "Session ended"
    }
    if (agent.state == "idle" && agent.task.lowercase() in setOf("done", "turn completed", "ready for an instruction")) {
        val response = latestEvent(agent) { it.kind == "output" && it.summary == "Response" && !it.detail.isNullOrBlank() }
        return response?.detail?.let { "Last response · $it" } ?: "Turn completed"
    }
    if (agent.task.endsWith(" completed")) return "${agent.task.removeSuffix(" completed")} finished · continuing"
    if (agent.task.startsWith("Using ")) return "Running ${agent.task.removePrefix("Using ")}"
    return agent.task
}

@Composable
private fun ProjectGroupHeader(project: String, agents: List<Agent>, showAttention: Boolean = true) {
    val waiting = if (showAttention) agents.count { it.state == "waiting" || it.state == "error" } else 0
    Row(Modifier.fillMaxWidth().padding(top = 7.dp, bottom = 1.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.FolderOpen, null, tint = Muted, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(7.dp))
        Text(project, color = Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(if (waiting > 0) "$waiting need you" else "${agents.size} session${if (agents.size == 1) "" else "s"}", color = if (waiting > 0) Amber else Muted, fontSize = 11.sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArchivableAgentCard(agent: Agent, homeState: HomeAgentState, busy: Boolean, archiveEnabled: Boolean, onArchive: () -> Unit, onClick: () -> Unit) {
    val content: @Composable () -> Unit = {
        if (homeState.compact) CompactAgentCard(agent, homeState, busy, onClick)
        else AgentCard(agent, homeState, busy, onClick)
    }
    if (!archiveEnabled) {
        content()
        return
    }
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) { onArchive(); true } else false
        },
    )
    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(Modifier.fillMaxSize().clip(RoundedCornerShape(22.dp)).background(Blue.copy(alpha = 0.14f)).padding(end = 22.dp), contentAlignment = Alignment.CenterEnd) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Archive", color = Blue, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(8.dp))
                    Icon(Icons.Rounded.Archive, "Archive", tint = Blue)
                }
            }
        },
    ) { content() }
}

private fun homeStateColor(state: HomeAgentState) = when {
    state == HomeAgentState.Failed -> Danger
    state.attention -> Amber
    state == HomeAgentState.Running -> Signal
    state == HomeAgentState.RecentlyCompleted -> Blue
    else -> Muted
}

@Composable
private fun AgentCard(agent: Agent, homeState: HomeAgentState, busy: Boolean, onClick: () -> Unit) {
    val statusColor = homeStateColor(homeState)
    val harness = remember(agent.name) { harnessFor(agent) }
    val provider = remember(agent.name, agent.model) { providerFor(agent) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.96f else 1f, tween(120), label = "card-press")
    val progress by animateFloatAsState((agent.progress ?: 0.0).toFloat(), label = "agent-progress")
    val activity = remember(agent.state, agent.task, agent.objective, agent.pendingApproval, agent.events) { agentCardActivity(agent) }
    val reasoningPreview = remember(agent.state, agent.events) { latestReasoningPreview(agent) }
    Surface(
        modifier = Modifier.fillMaxWidth().graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(22.dp))
            .clickable(interactionSource = interaction, indication = LocalIndication.current, onClick = onClick),
        shape = RoundedCornerShape(22.dp),
        color = if (homeState.attention) SurfaceRaised else Surface,
        border = if (homeState.attention) BorderStroke(1.dp, statusColor.copy(alpha = 0.28f)) else null,
        tonalElevation = 0.dp,
    ) {
        Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                HarnessMark(harness, running = agent.state == "running", statusColor = statusColor)
                Spacer(Modifier.width(13.dp))
                Column(Modifier.weight(1f)) {
                    Text(harness.label + sessionSuffix(agent), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                else StatusLabel(homeState.label, statusColor)
            }
            Column(Modifier.heightIn(min = 40.dp)) {
                Text(
                    usefulTask(agent),
                    color = if (homeState.attention) statusColor else Text.copy(alpha = 0.9f),
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                    maxLines = if (reasoningPreview == null) 2 else 1,
                    overflow = TextOverflow.Ellipsis,
                )
                reasoningPreview?.let {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Psychology, "Current reasoning", tint = Blue, modifier = Modifier.size(13.dp))
                        Spacer(Modifier.width(5.dp))
                        Text(it, color = Blue.copy(alpha = 0.9f), fontSize = 12.sp, lineHeight = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(18.dp), contentAlignment = Alignment.CenterStart) {
                if (agent.progress != null) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        LinearProgressIndicator(
                            progress = { progress },
                            modifier = Modifier.weight(1f).height(4.dp).clip(CircleShape),
                            color = statusColor,
                            trackColor = Line,
                        )
                        Spacer(Modifier.width(9.dp))
                        Text("${(progress * 100).roundToInt()}%", color = Muted, fontSize = 11.sp)
                    }
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            when (homeState) {
                                HomeAgentState.ApprovalRequired -> Icons.Rounded.VerifiedUser
                                HomeAgentState.Question -> Icons.AutoMirrored.Rounded.HelpOutline
                                HomeAgentState.InputRequired -> Icons.Rounded.Keyboard
                                HomeAgentState.Failed -> Icons.Rounded.ErrorOutline
                                else -> Icons.Rounded.Bolt
                            },
                            null,
                            tint = statusColor,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(Modifier.width(7.dp))
                        Text(activity, color = Muted, fontSize = 12.sp, lineHeight = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                ProviderMark(provider)
                Spacer(Modifier.width(7.dp))
                Text(provider.model, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(3.dp))
                Icon(Icons.Rounded.ChevronRight, null, tint = Muted.copy(alpha = 0.7f), modifier = Modifier.size(17.dp).offset(x = 1.dp))
            }
        }
    }
}

@Composable
private fun CompactAgentCard(agent: Agent, homeState: HomeAgentState, busy: Boolean, onClick: () -> Unit) {
    val harness = remember(agent.name) { harnessFor(agent) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, tween(120), label = "compact-card-press")
    val color = homeStateColor(homeState)
    Surface(
        modifier = Modifier.fillMaxWidth().graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(18.dp))
            .clickable(interactionSource = interaction, indication = LocalIndication.current, onClick = onClick),
        shape = RoundedCornerShape(18.dp),
        color = Surface,
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            HarnessMark(harness, running = false, statusColor = color, diameter = 40.dp)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(harness.label + sessionSuffix(agent), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Spacer(Modifier.width(7.dp))
                    Text(cardFreshness(agent.lastSeenAt), color = Muted, fontSize = 11.sp)
                }
                Text(usefulTask(agent), color = Muted, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(8.dp))
            if (busy) CircularProgressIndicator(Modifier.size(19.dp), strokeWidth = 2.dp)
            else Icon(Icons.Rounded.ChevronRight, null, tint = Muted.copy(alpha = 0.7f), modifier = Modifier.size(17.dp))
        }
    }
}

@Composable
private fun HarnessMark(harness: AgentHarness, running: Boolean, statusColor: Color, diameter: Dp = 50.dp) {
    Box(Modifier.size(diameter), contentAlignment = Alignment.Center) {
        Box(Modifier.size(diameter * 0.82f)) {
            Surface(
                shape = CircleShape,
                color = harness.color.copy(alpha = if (harness == AgentHarness.Codex) 0.1f else 0.14f),
                modifier = Modifier.fillMaxSize(),
            ) {
                Box(contentAlignment = Alignment.Center) { AgentLogo(harness, Modifier.size(diameter * 0.4f)) }
            }
            if (running) {
                CircularProgressIndicator(
                    modifier = Modifier.fillMaxSize(),
                    color = statusColor.copy(alpha = 0.78f),
                    trackColor = Line,
                    strokeWidth = 2.5.dp,
                )
            } else {
                Box(
                    Modifier.align(Alignment.BottomEnd).offset(x = 1.5.dp, y = 1.5.dp)
                        .size(11.dp).clip(CircleShape).background(Ink).padding(2.dp)
                        .clip(CircleShape).background(statusColor),
                )
            }
        }
    }
}

@Composable
private fun AgentLogo(harness: AgentHarness, modifier: Modifier = Modifier) {
    when (harness) {
        AgentHarness.Pi -> Box(modifier, contentAlignment = Alignment.Center) {
            Text("π", color = harness.color, fontSize = 18.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.offset(x = 0.5.dp, y = (-1).dp), style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)))
        }
        AgentHarness.Claude -> Canvas(modifier) {
            val center = this.center
            val inner = size.minDimension * 0.13f
            val outer = size.minDimension * 0.39f
            repeat(8) { index ->
                val angle = index * PI.toFloat() / 4f
                drawLine(
                    harness.color,
                    start = androidx.compose.ui.geometry.Offset(center.x + cos(angle) * inner, center.y + sin(angle) * inner),
                    end = androidx.compose.ui.geometry.Offset(center.x + cos(angle) * outer, center.y + sin(angle) * outer),
                    strokeWidth = size.minDimension * 0.105f,
                    cap = StrokeCap.Round,
                )
            }
        }
        AgentHarness.Codex -> Canvas(modifier) {
            repeat(6) { index ->
                val angle = index * PI.toFloat() / 3f
                drawCircle(harness.color, size.minDimension * 0.13f, androidx.compose.ui.geometry.Offset(center.x + cos(angle) * size.minDimension * 0.28f, center.y + sin(angle) * size.minDimension * 0.28f))
            }
        }
        AgentHarness.Other -> Icon(Icons.Rounded.SmartToy, null, tint = harness.color, modifier = modifier)
    }
}

@Composable
private fun ProviderMark(provider: ProviderIdentity, diameter: androidx.compose.ui.unit.Dp = 20.dp) {
    Surface(shape = CircleShape, color = provider.color.copy(alpha = 0.13f), modifier = Modifier.size(diameter)) {
        Box(contentAlignment = Alignment.Center) {
            if (provider.name == "OpenAI") Canvas(Modifier.size(diameter * 0.6f)) {
                drawCircle(provider.color, radius = size.minDimension * 0.38f, style = Stroke(width = size.minDimension * 0.16f))
                drawCircle(provider.color, radius = size.minDimension * 0.1f)
            } else Text(provider.name.take(1), color = provider.color, fontSize = (diameter.value * 0.45f).sp, lineHeight = (diameter.value * 0.45f).sp, fontWeight = FontWeight.Bold, modifier = Modifier.offset(y = (-0.5).dp), style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)))
        }
    }
}

@Composable
private fun StatusLabel(state: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(state.replaceFirstChar { it.uppercase() }, color = color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

private enum class AgentViewMode { Responses, Reasoning, Diff, Terminal }

@Composable
private fun AgentSessionView(agent: Agent, busy: Boolean, commandError: String?, commandNotice: String?, onDismiss: () -> Unit, archived: Boolean, onArchiveToggle: () -> Unit, onControl: (String, String?) -> Unit, onQuestionAnswer: (AgentEvent, String) -> Unit, sessionChanges: List<AgentEvent>, onLoadChanges: () -> Unit, sessionHistory: List<AgentEvent>, onLoadHistory: () -> Unit, slashCommands: List<SlashCommand>, onLoadSlashCommands: () -> Unit) {
    var mode by rememberSaveable(agent.id) { mutableStateOf(AgentViewMode.Responses) }
    var confirmingStop by rememberSaveable(agent.id) { mutableStateOf(false) }
    val supports: (String) -> Boolean = { action -> supportsCapability(agent.capabilities, action) }
    val pendingApproval = agent.pendingApproval?.takeIf { agent.state == "waiting" }
    // Tabs show whole histories, so they read the retained history merged with the live window
    // rather than the window alone, which a busy session overflows in minutes.
    val sessionAgent = remember(agent, sessionHistory) {
        val merged = mergeSessionEvents(sessionHistory, agent.events)
        if (merged === agent.events) agent else agent.copy(events = merged)
    }
    val pendingQuestion = latestEvent(sessionAgent) { it.kind == "question" }?.takeIf { agent.state == "waiting" }
    val harness = harnessFor(agent)
    val provider = providerFor(agent)
    val stateColor = statusColor(agent.state)
    val activity = remember(agent.state, agent.task, agent.objective, agent.pendingApproval, agent.events) { agentCardActivity(agent) }
    val reasoningCount = remember(sessionAgent.events) { reasoningEvents(sessionAgent.events).size }
    // Prefer the bridge's full history; fall back to whatever the live window still holds while it loads.
    var changesLoaded by remember(agent.id) { mutableStateOf(false) }
    LaunchedEffect(sessionChanges) { if (sessionChanges.isNotEmpty()) changesLoaded = true }
    val fileChanges = remember(sessionChanges) { agentFileChanges(sessionChanges) }
    val terminalCount = remember(sessionAgent.events) { terminalEvents(sessionAgent.events).size }
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
                fetchedAt = liveActivity
            }
            delay(20_000)
        }
    }
    LaunchedEffect(agent.id) { onLoadSlashCommands() }
    BackHandler { onDismiss() }

    Surface(Modifier.fillMaxSize(), color = Ink) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Surface(color = SurfaceRaised) {
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onDismiss, modifier = Modifier.size(44.dp)) {
                            Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back to agents")
                        }
                        HarnessMark(harness, running = agent.state == "running", statusColor = stateColor, diameter = 40.dp)
                        Spacer(Modifier.width(9.dp))
                        Column(Modifier.weight(1f)) {
                            // The project leads, because that is what a person
                            // is looking for. The runtime is a detail about it,
                            // and the session's hex id identified nothing a
                            // person recognises - the same reason it came off
                            // the watch.
                            Text(agent.project, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${harness.label} · ${provider.model}", color = Muted, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        // Icon only: the word cost a third of the title's width
                        // for an action taken once in a session's life.
                        IconButton(onClick = onArchiveToggle, modifier = Modifier.size(44.dp)) {
                            Icon(
                                if (archived) Icons.Rounded.Unarchive else Icons.Rounded.Archive,
                                if (archived) "Restore session" else "Archive session",
                                tint = Muted,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 2.dp, bottom = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        StatusLabel(agent.state, stateColor)
                        Text(" · ", color = Muted.copy(alpha = 0.65f), fontSize = 12.sp)
                        Text(activity, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        val pauseAction = if (isPaused) "resume" else "pause"
                        if (supports(pauseAction)) FilledTonalIconButton(onClick = { onControl(pauseAction, null) }, enabled = !busy, modifier = Modifier.size(40.dp)) {
                            Icon(if (isPaused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause, if (isPaused) "Resume agent" else "Pause agent", modifier = if (isPaused) Modifier.offset(x = 1.dp) else Modifier.size(20.dp))
                        }
                        if (supports("stop")) {
                            Spacer(Modifier.width(5.dp))
                            FilledTonalIconButton(
                                onClick = { confirmingStop = true },
                                enabled = !busy,
                                modifier = Modifier.size(40.dp),
                                colors = IconButtonDefaults.filledTonalIconButtonColors(contentColor = Danger),
                            ) { Icon(Icons.Rounded.Stop, "Stop agent", modifier = Modifier.size(19.dp)) }
                        }
                    }
                    if (hasAttention) {
                        Surface(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp).clip(RoundedCornerShape(12.dp)).clickable { mode = AgentViewMode.Responses },
                            color = Amber.copy(alpha = 0.10f),
                            border = BorderStroke(1.dp, Amber.copy(alpha = 0.22f)),
                        ) {
                            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(if (pendingApproval != null) Icons.Rounded.VerifiedUser else Icons.AutoMirrored.Rounded.HelpOutline, null, tint = Amber, modifier = Modifier.size(17.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(if (pendingApproval != null) "Approval required" else "Question waiting", color = Amber, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.weight(1f))
                                Text("Review in Chat", color = Muted, fontSize = 11.sp)
                                Spacer(Modifier.width(3.dp))
                                Icon(Icons.Rounded.ChevronRight, null, tint = Muted, modifier = Modifier.size(17.dp))
                            }
                        }
                    }
                    PrimaryTabRow(selectedTabIndex = mode.ordinal, containerColor = SurfaceRaised, divider = { HorizontalDivider(color = Line) }) {
                        Tab(selected = mode == AgentViewMode.Responses, onClick = { mode = AgentViewMode.Responses }, text = { SessionTabLabel("Chat", attention = hasAttention) })
                        Tab(selected = mode == AgentViewMode.Reasoning, onClick = { mode = AgentViewMode.Reasoning }, text = { SessionTabLabel("Reasoning", reasoningCount) })
                        Tab(selected = mode == AgentViewMode.Diff, onClick = { mode = AgentViewMode.Diff }, text = { SessionTabLabel("Changes", fileChanges.size) })
                        Tab(selected = mode == AgentViewMode.Terminal, onClick = { mode = AgentViewMode.Terminal }, text = { SessionTabLabel("Terminal", terminalCount) })
                    }
                }
            }
            when (mode) {
                AgentViewMode.Responses -> ResponsesView(
                    agent = sessionAgent,
                    busy = busy,
                    pendingApproval = pendingApproval,
                    pendingQuestion = pendingQuestion,
                    commandError = commandError,
                    commandNotice = commandNotice,
                    supports = supports,
                    slashCommands = slashCommands,
                    onControl = onControl,
                    onQuestionAnswer = onQuestionAnswer,
                    modifier = Modifier.weight(1f),
                )
                AgentViewMode.Reasoning -> ReasoningView(sessionAgent, Modifier.weight(1f).navigationBarsPadding())
                AgentViewMode.Diff -> DiffView(fileChanges, changesLoaded, Modifier.weight(1f).navigationBarsPadding())
                AgentViewMode.Terminal -> TerminalView(sessionAgent, busy, commandError, commandNotice, supports, onControl, Modifier.weight(1f))
            }
        }
    }
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

@Composable
private fun SessionTabLabel(label: String, count: Int = 0, attention: Boolean = false) {
    // A count, not a number. Every tab in a working session reads "99+", which
    // says only that there is a lot of everything - while squeezing the label
    // it sits beside into "Reaso…". A dot says the same thing in no space, and
    // the real number is visible the moment the tab is open.
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 13.sp)
        if (attention || count > 0) {
            Spacer(Modifier.width(5.dp))
            Box(
                Modifier
                    .size(if (attention) 6.dp else 4.dp)
                    .clip(CircleShape)
                    // Amber is reserved for something wanting a person; anything
                    // else is just content waiting to be read.
                    .background(if (attention) Amber else Muted.copy(alpha = 0.55f)),
            )
        }
    }
}

@Composable
private fun ResponsesView(
    agent: Agent,
    busy: Boolean,
    pendingApproval: PendingApproval?,
    pendingQuestion: AgentEvent?,
    commandError: String?,
    commandNotice: String?,
    supports: (String) -> Boolean,
    slashCommands: List<SlashCommand>,
    onControl: (String, String?) -> Unit,
    onQuestionAnswer: (AgentEvent, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val entries = remember(agent.events) { conversationEntries(agent.events) }
    val initialLastItem = entries.size + listOfNotNull(pendingQuestion, pendingApproval).size - 1
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
    val newestContentKey = listOf(
        entries.lastOrNull()?.event?.id,
        entries.lastOrNull()?.content?.hashCode(),
        pendingQuestion?.id,
        pendingApproval?.id,
    )
    LaunchedEffect(newestContentKey) {
        val lastItem = entries.size + listOfNotNull(pendingQuestion, pendingApproval).size - 1
        if (lastItem < 0) return@LaunchedEffect
        if (!ResponseScrollPolicy.shouldMoveToNewest(initialPositionApplied, followNewest)) {
            newMessagesWaiting = initialPositionApplied
            return@LaunchedEffect
        }
        listState.scrollToEnd(lastItem)
        initialPositionApplied = true
        newMessagesWaiting = false
    }
    LaunchedEffect(listState, entries.size, pendingQuestion?.id, pendingApproval?.id) {
        snapshotFlow { listState.canScrollForward }.distinctUntilChanged().collect { canScrollForward ->
            if (!ResponseScrollPolicy.shouldCorrectLayoutGrowth(initialPositionApplied, followNewest, userDragging, canScrollForward)) return@collect
            val lastItem = entries.size + listOfNotNull(pendingQuestion, pendingApproval).size - 1
            if (lastItem >= 0) listState.scrollToEnd(lastItem)
        }
    }
    Column(modifier.background(Ink)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (initialPositionApplied || initialLastItem < 0) 1f else 0f },
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
            if (entries.isEmpty() && pendingApproval == null && pendingQuestion == null) item {
                EmptyConversation(supportsMessaging = listOf("prompt", "steer", "follow_up").any(supports))
            }
            items(entries, key = { "message:${it.event.id}" }) { entry -> ConversationBubble(entry, providerFor(agent)) }
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
            }
            if (newMessagesWaiting) FilledTonalButton(
                onClick = {
                    followNewest = true
                    newMessagesWaiting = false
                    val lastItem = entries.size + listOfNotNull(pendingQuestion, pendingApproval).size - 1
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
        MessageComposer(agent, busy, commandError, commandNotice, supports, slashCommands, onControl)
    }
}

@Composable
private fun ConversationBubble(entry: ConversationEntry, provider: ProviderIdentity) {
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
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            ProviderMark(provider, 32.dp)
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                Surface(shape = bubbleShape, color = SurfaceRaised, modifier = Modifier.fillMaxWidth()) {
                    Box(Modifier.padding(horizontal = 14.dp, vertical = 11.dp)) { MarkdownResponse(entry.content) }
                }
                Text(formatMessageTime(entry.event.createdAt), color = Muted.copy(alpha = 0.78f), fontSize = 10.sp, modifier = Modifier.padding(start = 5.dp, end = 5.dp, top = 3.dp))
            }
        }
    }
}

@Composable
private fun EmptyConversation(supportsMessaging: Boolean) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Rounded.Forum, null, tint = Muted, modifier = Modifier.size(30.dp))
        Text("No responses yet", fontWeight = FontWeight.SemiBold)
        Text(if (supportsMessaging) "Send a message to begin." else "This runtime is monitoring-only.", color = Muted, fontSize = 13.sp)
    }
}

@Composable
private fun SlashCommandPicker(matches: List<SlashCommand>, onPick: (SlashCommand) -> Unit) {
    // Capped so the sheet never swallows the conversation; the list scrolls beyond that.
    LazyColumn(
        modifier = Modifier.fillMaxWidth().heightIn(max = 224.dp).padding(bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        items(matches, key = { it.name }) { command ->
            Surface(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { onPick(command) },
                color = Color.Transparent,
            ) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("/${command.name}", color = Blue, fontFamily = FontFamily.Monospace, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        command.description?.takeIf(String::isNotBlank)?.let {
                            Text(it, color = Muted, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (command.source != "user") {
                        Spacer(Modifier.width(8.dp))
                        Text(command.source, color = Muted.copy(alpha = 0.7f), fontSize = 9.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageComposer(agent: Agent, busy: Boolean, commandError: String?, commandNotice: String?, supports: (String) -> Boolean, slashCommands: List<SlashCommand>, onControl: (String, String?) -> Unit) {
    var message by rememberSaveable(agent.id) { mutableStateOf("") }
    val action = remoteMessageAction(agent.state, supports)
    if (action == null) {
        Text("This runtime does not accept remote messages.", color = Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(16.dp))
        return
    }
    val query = slashCommandQuery(message)
    val matches = remember(query, slashCommands) { query?.let { matchSlashCommands(it, slashCommands) }.orEmpty() }
    Surface(color = SurfaceRaised, tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 10.dp)) {
            if (matches.isNotEmpty()) SlashCommandPicker(matches) { message = "/${it.name} " }
            else if (query != null && slashCommands.isEmpty()) {
                Text("No commands reported by this runtime.", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
            }
            commandError?.let { Text(it, color = Danger, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) }
            if (commandError == null) {
                commandNotice?.let { Text(it, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
            ) {
            // One rounded field, the way every messaging app draws one. The
            // outlined variant put a visible box inside a raised bar - two
            // borders around the same thing - and the slash button lives inside
            // it because it acts on what is being typed, not on the session.
            Surface(
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(24.dp),
                color = SurfaceSunken,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = { message = if (message.startsWith("/")) message else "/$message" },
                        modifier = Modifier.size(42.dp),
                    ) {
                        Icon(
                            Icons.Rounded.Bolt,
                            "Slash command",
                            tint = if (message.startsWith("/")) Signal else Muted,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    TextField(
                        value = message,
                        onValueChange = { message = it },
                        modifier = Modifier.weight(1f),
                        placeholder = {
                            Text(
                                if (action == "steer") "Reply or steer…" else "Message agent…",
                                color = Muted,
                                fontSize = 15.sp,
                            )
                        },
                        textStyle = LocalTextStyle.current.copy(fontSize = 15.sp),
                        minLines = 1,
                        maxLines = 4,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            disabledContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                        ),
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            FilledIconButton(
                onClick = { val content = message.trim(); onControl(action, content); message = "" },
                enabled = message.isNotBlank() && !busy,
                modifier = Modifier.size(46.dp),
                shape = CircleShape,
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Icon(Icons.Rounded.ArrowUpward, "Send message", modifier = Modifier.size(20.dp))
            }
        }
    }
}
}

@Composable
private fun ReasoningView(agent: Agent, modifier: Modifier = Modifier) {
    val events = remember(agent.events) { reasoningEvents(agent.events) }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = events.lastIndex.coerceAtLeast(0))
    val scope = rememberCoroutineScope()
    var followNewest by remember(agent.id) { mutableStateOf(true) }
    var userDragging by remember(agent.id) { mutableStateOf(false) }
    var initialPositionApplied by remember(agent.id) { mutableStateOf(false) }
    var newReasoningWaiting by remember(agent.id) { mutableStateOf(false) }
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
                    if (followNewest) newReasoningWaiting = false
                }
            }
        }
    }
    val newestKey = events.lastOrNull()?.let { it.id to it.detail.hashCode() }
    LaunchedEffect(newestKey) {
        if (events.isEmpty()) return@LaunchedEffect
        if (!ResponseScrollPolicy.shouldMoveToNewest(initialPositionApplied, followNewest)) {
            newReasoningWaiting = initialPositionApplied
            return@LaunchedEffect
        }
        listState.scrollToEnd(events.lastIndex)
        initialPositionApplied = true
        newReasoningWaiting = false
    }
    LaunchedEffect(listState, events.size) {
        snapshotFlow { listState.canScrollForward }.distinctUntilChanged().collect { canScrollForward ->
            if (!ResponseScrollPolicy.shouldCorrectLayoutGrowth(initialPositionApplied, followNewest, userDragging, canScrollForward)) return@collect
            if (events.isNotEmpty()) listState.scrollToEnd(events.lastIndex)
        }
    }
    Column(modifier.fillMaxWidth().background(Ink)) {
        Surface(color = Blue.copy(alpha = 0.08f)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Visibility, null, tint = Blue, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(9.dp))
                Text("Only reasoning explicitly shared by the provider is shown.", color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (initialPositionApplied || events.isEmpty()) 1f else 0f },
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(events, key = { "reasoning:${it.id}" }) { event ->
                    Surface(shape = RoundedCornerShape(16.dp), color = SurfaceRaised) {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Rounded.Psychology, null, tint = Blue, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(if (event.summary.endsWith("…")) "Thinking" else "Reasoning", color = Blue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.weight(1f))
                                Text(formatMessageTime(event.createdAt), color = Muted.copy(alpha = 0.72f), fontSize = 10.sp)
                            }
                            MarkdownResponse(event.detail.orEmpty())
                        }
                    }
                }
                if (events.isEmpty()) item {
                    Column(Modifier.fillMaxWidth().padding(vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Icons.Rounded.Psychology, null, tint = Muted, modifier = Modifier.size(30.dp))
                        Text("No shared reasoning", fontWeight = FontWeight.SemiBold)
                        Text("This model has not exposed reasoning for this session.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp))
                    }
                }
            }
            if (newReasoningWaiting) FilledTonalButton(
                onClick = {
                    followNewest = true
                    newReasoningWaiting = false
                    if (events.isNotEmpty()) scope.launch { listState.scrollToEnd(events.lastIndex) }
                },
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).heightIn(min = 44.dp),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Icon(Icons.Rounded.ArrowDownward, null, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(7.dp))
                Text("New reasoning")
            }
        }
    }
}

@Composable
private fun DiffView(files: List<AgentFileChange>, loaded: Boolean, modifier: Modifier = Modifier) {
    val additions = files.sumOf { it.additions }
    val deletions = files.sumOf { it.deletions }
    var allExpanded by rememberSaveable { mutableStateOf(true) }
    var expandRevision by rememberSaveable { mutableStateOf(0) }
    Column(modifier.fillMaxWidth().background(Ink)) {
        Row(
            modifier = Modifier.fillMaxWidth().height(48.dp).background(Color(0xFF0C1014)).padding(start = 16.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(17.dp))
            Spacer(Modifier.width(8.dp))
            Text("${files.size} ${if (files.size == 1) "file" else "files"} changed", color = Text.copy(alpha = 0.86f), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            if (additions > 0) Text("+$additions", color = Signal, fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            if (additions > 0 && deletions > 0) Spacer(Modifier.width(10.dp))
            if (deletions > 0) Text("−$deletions", color = Danger, fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            if (files.isNotEmpty()) {
                Spacer(Modifier.width(4.dp))
                IconButton(
                    onClick = {
                        allExpanded = !allExpanded
                        expandRevision += 1
                    },
                    modifier = Modifier.size(40.dp),
                ) {
                    Icon(
                        if (allExpanded) Icons.Rounded.UnfoldLess else Icons.Rounded.UnfoldMore,
                        if (allExpanded) "Collapse all files" else "Expand all files",
                        tint = Muted,
                        modifier = Modifier.size(19.dp),
                    )
                }
            }
        }
        if (files.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(32.dp))
                Spacer(Modifier.height(12.dp))
                // Until the session's changes have been fetched, "none" is not yet known.
                Text(if (loaded) "No captured changes" else "Loading changes…", fontWeight = FontWeight.SemiBold)
                if (loaded) {
                    Spacer(Modifier.height(6.dp))
                    Text("Edits and writes exposed by this runtime will appear here.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp, textAlign = TextAlign.Center)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(files, key = { "diff:${it.path}" }) { file ->
                    DiffFileCard(file, expandedByDefault = allExpanded, expandRevision = expandRevision)
                }
            }
        }
    }
}

@Composable
private fun DiffFileCard(file: AgentFileChange, expandedByDefault: Boolean, expandRevision: Int) {
    var expanded by rememberSaveable(file.path, expandRevision) { mutableStateOf(expandedByDefault) }
    var showAllLines by rememberSaveable(file.path) { mutableStateOf(false) }
    val truncated = file.lineCount > DIFF_LINE_BUDGET && !showAllLines
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = Surface,
        border = BorderStroke(1.dp, Line),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(start = 12.dp, end = 8.dp, top = 11.dp, bottom = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Description, null, tint = Blue, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(8.dp))
                // Start-ellipsis keeps the file name readable; the leading directories are the droppable part.
                Text(file.path, color = Text.copy(alpha = 0.9f), fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.weight(1f))
                if (file.additions > 0) Text("+${file.additions}", color = Signal, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                if (file.additions > 0 && file.deletions > 0) Spacer(Modifier.width(8.dp))
                if (file.deletions > 0) Text("−${file.deletions}", color = Danger, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                Spacer(Modifier.width(5.dp))
                Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, if (expanded) "Collapse file" else "Expand file", tint = Muted, modifier = Modifier.size(18.dp))
            }
            if (expanded) {
                HorizontalDivider(color = Line)
                SelectionContainer {
                    BoxWithConstraints(Modifier.fillMaxWidth()) {
                        val viewportWidth = maxWidth
                        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                            // A horizontal scroller hands children infinite width, so fillMaxWidth() on a
                            // row is a no-op and each line's tint stops at its own text. Pinning the column
                            // to its widest line gives the rows a real width to fill, edge to edge.
                            Column(Modifier.widthIn(min = viewportWidth).width(IntrinsicSize.Max)) {
                                var rendered = 0
                                val budget = if (truncated) DIFF_LINE_BUDGET else Int.MAX_VALUE
                                file.hunks.forEachIndexed { index, hunk ->
                                    if (rendered >= budget) return@forEachIndexed
                                    if (index > 0) {
                                        Row(Modifier.fillMaxWidth().background(Blue.copy(alpha = 0.06f)).padding(horizontal = 10.dp, vertical = 5.dp)) {
                                            Text("Change ${index + 1} · ${formatMessageTime(hunk.createdAt)}", color = Blue, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
                                        }
                                    }
                                    for (line in hunk.lines) {
                                        if (rendered >= budget) break
                                        DiffLineRow(line, showLineNumbers = file.hasLineNumbers)
                                        rendered += 1
                                    }
                                }
                            }
                        }
                    }
                }
                if (file.lineCount > DIFF_LINE_BUDGET) {
                    HorizontalDivider(color = Line)
                    TextButton(
                        onClick = { showAllLines = !showAllLines },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
                    ) {
                        Text(
                            if (truncated) "Show all ${file.lineCount} lines" else "Show first $DIFF_LINE_BUDGET lines",
                            color = Blue,
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}

/** Long file rewrites arrive as thousands of `+` lines; render a readable slice until asked for the rest. */
private const val DIFF_LINE_BUDGET = 300

@Composable
private fun DiffLineRow(line: AgentDiffLine, showLineNumbers: Boolean) {
    val background = when (line.kind) {
        DiffLineKind.Addition -> Signal.copy(alpha = 0.10f)
        DiffLineKind.Deletion -> Danger.copy(alpha = 0.10f)
        DiffLineKind.Header -> Blue.copy(alpha = 0.08f)
        DiffLineKind.Context -> Color.Transparent
    }
    val foreground = when (line.kind) {
        DiffLineKind.Addition -> Signal
        DiffLineKind.Deletion -> Danger
        DiffLineKind.Header -> Blue
        DiffLineKind.Context -> Text.copy(alpha = 0.78f)
    }
    val marker = when (line.kind) {
        DiffLineKind.Addition -> "+"
        DiffLineKind.Deletion -> "−"
        else -> " "
    }
    // Deletions are positioned in the old file, everything else in the new one.
    val lineNumber = if (line.kind == DiffLineKind.Deletion) line.oldLine else line.newLine
    Row(Modifier.fillMaxWidth().background(background).heightIn(min = 24.dp), verticalAlignment = Alignment.Top) {
        if (showLineNumbers) {
            Box(
                Modifier.width(40.dp).heightIn(min = 24.dp).padding(end = 6.dp),
                contentAlignment = Alignment.TopEnd,
            ) {
                Text(
                    lineNumber?.toString().orEmpty(),
                    color = Muted.copy(alpha = 0.55f),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    lineHeight = 20.sp,
                )
            }
        }
        Box(Modifier.width(24.dp).heightIn(min = 24.dp).background(foreground.copy(alpha = 0.08f)), contentAlignment = Alignment.TopCenter) {
            Text(marker, color = foreground, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 20.sp)
        }
        Text(
            if (line.kind == DiffLineKind.Header) hunkHeaderContext(line.text) ?: line.text else line.text.ifEmpty { " " },
            color = foreground,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            lineHeight = 20.sp,
            softWrap = false,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun TerminalView(
    agent: Agent,
    busy: Boolean,
    commandError: String?,
    commandNotice: String?,
    supports: (String) -> Boolean,
    onControl: (String, String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val events = remember(agent.events) { terminalEvents(agent.events) }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = events.lastIndex.coerceAtLeast(0))
    val scope = rememberCoroutineScope()
    var followNewest by remember(agent.id) { mutableStateOf(true) }
    var initialPositionApplied by remember(agent.id) { mutableStateOf(false) }
    var newCommandsWaiting by remember(agent.id) { mutableStateOf(false) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> followNewest = false
                is DragInteraction.Stop, is DragInteraction.Cancel -> {
                    followNewest = !listState.canScrollForward
                    if (followNewest) newCommandsWaiting = false
                }
            }
        }
    }
    val newestKey = events.lastOrNull()?.let { listOf(it.id, it.command.hashCode(), events.size) }
    LaunchedEffect(newestKey) {
        if (events.isEmpty()) return@LaunchedEffect
        if (initialPositionApplied && !followNewest) {
            newCommandsWaiting = true
            return@LaunchedEffect
        }
        listState.scrollToEnd(events.lastIndex)
        initialPositionApplied = true
        newCommandsWaiting = false
    }
    Column(modifier.fillMaxWidth().background(Color(0xFF050709))) {
        Row(
            modifier = Modifier.fillMaxWidth().height(48.dp).background(Color(0xFF0C1014)).padding(start = 16.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(7.dp).clip(CircleShape).background(if (followNewest) Signal else Amber))
            Spacer(Modifier.width(9.dp))
            Text(agent.project, color = Text.copy(alpha = 0.82f), fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("${events.size} ${if (events.size == 1) "command" else "commands"}", color = Muted.copy(alpha = 0.72f), fontFamily = FontFamily.Monospace, fontSize = 10.sp)
            IconButton(
                onClick = {
                    followNewest = true
                    newCommandsWaiting = false
                    if (events.isNotEmpty()) scope.launch { listState.scrollToEnd(events.lastIndex) }
                },
                enabled = events.isNotEmpty(),
                modifier = Modifier.size(44.dp),
            ) { Icon(Icons.Rounded.VerticalAlignBottom, "Jump to latest command", tint = if (followNewest) Signal else Muted, modifier = Modifier.size(18.dp)) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            SelectionContainer {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (initialPositionApplied || events.isEmpty()) 1f else 0f },
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(events, key = { "terminal:${it.id}" }) { event ->
                        Column(Modifier.fillMaxWidth()) {
                            Text(formatTerminalTime(event.createdAt), color = Muted.copy(alpha = 0.66f), fontFamily = FontFamily.Monospace, fontSize = 10.sp, lineHeight = 14.sp)
                            Spacer(Modifier.height(3.dp))
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                                Text("\$", color = Signal, fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 21.sp, fontWeight = FontWeight.Bold)
                                Spacer(Modifier.width(10.dp))
                                Text(event.command.orEmpty(), color = Text.copy(alpha = 0.92f), fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.weight(1f))
                            }
                        }
                    }
                    if (events.isEmpty()) item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("\$", color = Signal, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                            Spacer(Modifier.width(10.dp))
                            Text("Waiting for the first shell command…", color = Muted, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                        }
                    }
                }
            }
            if (newCommandsWaiting) FilledTonalButton(
                onClick = {
                    followNewest = true
                    newCommandsWaiting = false
                    scope.launch { listState.scrollToEnd(events.lastIndex) }
                },
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).heightIn(min = 44.dp),
            ) {
                Icon(Icons.Rounded.ArrowDownward, null, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(7.dp))
                Text("New commands")
            }
        }
        TerminalCommandComposer(agent, busy, commandError, commandNotice, supports, onControl)
    }
}

@Composable
private fun TerminalCommandComposer(
    agent: Agent,
    busy: Boolean,
    commandError: String?,
    commandNotice: String?,
    supports: (String) -> Boolean,
    onControl: (String, String?) -> Unit,
) {
    val action = remoteMessageAction(agent.state, supports) ?: return
    var command by rememberSaveable(agent.id) { mutableStateOf("") }
    Surface(color = Color(0xFF0C1014), tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 10.dp)) {
            commandError?.let { Text(it, color = Danger, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) }
            if (commandError == null) {
                commandNotice?.let { Text(it, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) }
            }
            Row(Modifier.padding(start = 8.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.VerifiedUser, null, tint = Muted, modifier = Modifier.size(13.dp))
                Spacer(Modifier.width(6.dp))
                Text("Agent-mediated · runtime permissions apply", color = Muted, fontSize = 11.sp, lineHeight = 15.sp)
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = command,
                    onValueChange = { command = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Command for agent…", fontFamily = FontFamily.Monospace) },
                    prefix = { Text("\$ ", color = Signal, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold) },
                    textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 20.sp, color = Text),
                    shape = RoundedCornerShape(16.dp),
                    minLines = 1,
                    maxLines = 4,
                )
                FilledIconButton(
                    onClick = {
                        val exact = command.trim()
                        onControl(action, terminalCommandInstruction(exact))
                        command = ""
                    },
                    enabled = command.isNotBlank() && !busy,
                    modifier = Modifier.size(52.dp),
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Rounded.ArrowUpward, "Ask agent to run command")
                }
            }
        }
    }
}

private suspend fun LazyListState.scrollToEnd(lastItem: Int) {
    withFrameNanos { }
    scrollToItem(lastItem)
    scrollBy(Float.MAX_VALUE)
}

private val messageTimeFormatter = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
private val terminalTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())
private fun formatMessageTime(value: String): String = runCatching { messageTimeFormatter.format(Instant.parse(value)) }.getOrDefault(value.substringAfter('T').take(5))
private fun formatTerminalTime(value: String): String = runCatching { terminalTimeFormatter.format(Instant.parse(value)) }.getOrDefault(value.substringAfter('T').take(8))

@Composable
private fun QuestionCard(event: AgentEvent, answerable: Boolean, busy: Boolean, onAnswer: (String) -> Unit) {
    Surface(shape = RoundedCornerShape(18.dp), color = Amber.copy(alpha = 0.10f), border = BorderStroke(1.dp, Amber.copy(alpha = 0.24f))) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Rounded.HelpOutline, null, tint = Amber, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("Agent question", color = Amber, fontWeight = FontWeight.SemiBold)
            }
            Text(event.detail ?: event.summary, lineHeight = 21.sp)
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
private fun AgentEventCard(event: AgentEvent, expanded: Boolean, onToggle: () -> Unit) {
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
private fun MarkdownResponse(content: String) {
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
private fun MarkdownTable(table: ResponseBlock.Table, typography: MarkdownTypography) {
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
private fun StructuredCode(value: String, accent: Color) {
    Surface(shape = RoundedCornerShape(12.dp), color = Ink) {
        Text(value, color = accent, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.fillMaxWidth().padding(12.dp))
    }
}

@Composable
private fun ConnectionDialog(
    currentUrl: String,
    onDismiss: () -> Unit,
    onSave: (String, String, (Boolean, String?) -> Unit) -> Unit,
) {
    var url by remember { mutableStateOf(currentUrl) }
    var credential by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Rounded.Hub, null, tint = Signal) },
        title = { Text("Connect a bridge") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Use your machine's Tailscale IP or MagicDNS name, then enter the one-time code printed by the bridge.", color = Muted)
                OutlinedTextField(url, { url = it }, label = { Text("Bridge URL") }, singleLine = true, enabled = !working, shape = RoundedCornerShape(14.dp))
                OutlinedTextField(
                    credential,
                    { credential = it.filterNot(Char::isWhitespace); error = null },
                    label = { Text("Pairing code (optional)") },
                    supportingText = { Text(error ?: "Leave blank to keep this device's secure token") },
                    isError = error != null,
                    singleLine = true,
                    enabled = !working,
                    shape = RoundedCornerShape(14.dp),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    working = true
                    error = null
                    onSave(url, credential) { success, message ->
                        working = false
                        if (!success) error = message
                    }
                },
                enabled = url.isNotBlank() && !working,
            ) {
                if (working) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(if (credential.isBlank()) "Connect" else "Pair & connect")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = SurfaceRaised,
    )
}

@Composable
private fun EmptyBridge(state: BridgeState, onConfigure: () -> Unit, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Surface(shape = CircleShape, color = SurfaceRaised) { Icon(Icons.Rounded.Hub, null, tint = Muted, modifier = Modifier.padding(22.dp).size(34.dp)) }
            Text(if (state is BridgeState.Loading) "Finding your agents…" else "Bridge out of range", style = MaterialTheme.typography.titleLarge)
            Text(if (state is BridgeState.Failed) state.message else "Connecting securely over your tailnet", color = Muted)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onConfigure) { Text("Connection") }
                Button(onClick = onRetry) { Text("Try again") }
            }
        }
    }
}

@Composable
private fun OfflineBanner(message: String) {
    Surface(shape = RoundedCornerShape(16.dp), color = Danger.copy(alpha = 0.10f)) {
        Row(Modifier.fillMaxWidth().padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.CloudOff, null, tint = Danger, modifier = Modifier.size(19.dp))
            Spacer(Modifier.width(9.dp))
            Text("Showing last update · $message", color = Danger, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
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

private fun eventColor(kind: String) = when (kind) {
    "warning", "question" -> Amber
    "error" -> Danger
    "tool" -> Blue
    else -> Signal
}

private fun statusIcon(state: String) = when (state) {
    "running" -> Icons.Rounded.Bolt
    "waiting" -> Icons.Rounded.PriorityHigh
    "paused" -> Icons.Rounded.Pause
    "error", "offline" -> Icons.Rounded.CloudOff
    else -> Icons.Rounded.Check
}

private fun compact(value: Long): String = when {
    value >= 1_000_000 -> "%.1fM".format(value / 1_000_000.0)
    value >= 1_000 -> "%.1fk".format(value / 1_000.0)
    else -> NumberFormat.getIntegerInstance().format(value)
}
