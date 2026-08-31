package dev.agentdeck.mobile

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import android.view.RoundedCorner
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.viewModels
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
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
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.font.FontStyle
import java.time.format.DateTimeFormatter
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.roundToInt
import java.text.NumberFormat
import dev.agentdeck.shared.supportsCapability
import dev.agentdeck.shared.ConversationDays
import dev.agentdeck.shared.Harnesses
import dev.agentdeck.shared.Harness
import dev.agentdeck.shared.agentCardActivity
import dev.agentdeck.shared.SubagentRun
import dev.agentdeck.shared.eventsOfSubagent
import dev.agentdeck.shared.subagentRuns
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
        // Both system bars belong to the app's world, and that world is a
        // single committed dark one. The argument-less call takes its icon
        // colour from the *system* theme instead, so a phone set to light drew
        // dark status icons over a near-black app - 1.07:1, unreadable, on
        // every screen. It only ever looked right on a dark-themed phone.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
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
        ForegroundSession.foreground = true
        deckViewModel.onForeground()
    }

    override fun onPause() {
        // The completion notifier stays quiet for the session on screen; a
        // backgrounded app has no session on screen, whatever was open in it.
        ForegroundSession.foreground = false
        super.onPause()
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

/**
 * A message the bridge refused because the session is blocked on a person.
 *
 * Holds everything a "Send anyway" needs to resend verbatim, plus the
 * bridge's own sentence about what is pending. `at` exists so a second
 * identical refusal still reads as a new event to the composer.
 */
internal data class BlockedCommand(
    val agentId: String,
    val action: String,
    val value: String?,
    val detail: String,
    val at: Long = System.currentTimeMillis(),
)

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

    private val _commandBlocked = MutableStateFlow<BlockedCommand?>(null)

    /** The last message the bridge refused for a blocked session, until resolved or resent. */
    internal val commandBlocked = _commandBlocked.asStateFlow()

    fun control(agent: Agent, action: String, value: String? = null, force: Boolean = false) = viewModelScope.launch {
        _commandInFlight.value = agent.id
        _commandBlocked.value = null
        runCatching { repository.control(agent.id, action, value, force = force) }
            .onSuccess {
                _commandError.value = null
                // The bridge accepting a message is not the session receiving
                // it. Say which happened, rather than leaving silence to be
                // read as delivery.
                _commandNotice.value =
                    if (action in MESSAGE_ACTIONS) deliveryNotice(agent.state) else null
            }
            .onFailure {
                // A blocked refusal keeps the words: the draft goes back into
                // the composer with the bridge's reason beside it, instead of
                // vanishing into a generic error line.
                if (it is AgentBlockedException && action in MESSAGE_ACTIONS) {
                    _commandBlocked.value = BlockedCommand(agent.id, action, value, it.message ?: "This agent is waiting on an approval or question.")
                    _commandError.value = null
                } else {
                    _commandError.value = it.message ?: "Command delivery failed"
                }
                _commandNotice.value = null
            }
        _commandInFlight.value = null
    }

    /** Resends the refused message with `force`, the one explicit way past a blocked session. */
    fun sendAnyway(agent: Agent) {
        val blocked = _commandBlocked.value?.takeIf { it.agentId == agent.id } ?: return
        control(agent, blocked.action, blocked.value, force = true)
    }

    private val seenStore = SeenStore(application)
    private val _seenMarks = MutableStateFlow(seenStore.all())

    /** This phone's own read marks; the watch keeps its own, and neither trusts the other's. */
    val seenMarks = _seenMarks.asStateFlow()

    /** Called only from an open session screen - opening the deck list marks nothing. */
    fun markSeen(agent: Agent) {
        val at = latestActivityAt(agent)
        if (seenCovers(_seenMarks.value[agent.id], at)) return
        seenStore.markSeen(agent.id, at)
        _seenMarks.update { it + (agent.id to at) }
        // Echo the read to the bridge, so the other surfaces drop their badges
        // too. The local mark already applied; a bridge that cannot be reached
        // costs only that echo, so the failure is swallowed.
        viewModelScope.launch { runCatching { client.markSeen(agent.id) } }
    }

    private val _dismissedAgents = MutableStateFlow<Set<String>>(emptySet())

    /** Sessions removed optimistically, hidden until the bridge's own removal lands. */
    val dismissedAgents = _dismissedAgents.asStateFlow()

    private val _dismissError = MutableStateFlow<String?>(null)
    val dismissError = _dismissError.asStateFlow()

    /**
     * Removes an ended session from the deck, on every surface. The card
     * disappears now; the bridge confirms through the stream's `removed`. A
     * bridge that refuses puts the card back with its reason, and the local
     * hide is dropped once the bridge has answered either way - if the session
     * ever heartbeats again, the deck honestly shows it.
     */
    fun dismiss(agent: Agent) {
        _dismissedAgents.update { it + agent.id }
        _dismissError.value = null
        viewModelScope.launch {
            runCatching { client.dismiss(agent.id) }
                .onSuccess { repository.refresh() }
                .onFailure { _dismissError.value = it.message ?: "Could not dismiss the session" }
            _dismissedAgents.update { it - agent.id }
        }
        getApplication<Application>().getSystemService(NotificationManager::class.java).cancel(agent.id.hashCode())
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

    // MARK: - Start a session

    private val _managedRuntimes = MutableStateFlow<List<ManagedRuntime>>(emptyList())
    val managedRuntimes = _managedRuntimes.asStateFlow()

    private val _startingSession = MutableStateFlow(false)
    val startingSession = _startingSession.asStateFlow()

    private val _startError = MutableStateFlow<String?>(null)
    val startError = _startError.asStateFlow()

    /** Which runtimes the bridge can host, so the start sheet only shows what is real. */
    fun loadManagedRuntimes() = viewModelScope.launch {
        runCatching { repository.managedRuntimes() }
            .onSuccess { _managedRuntimes.value = it }
    }

    /**
     * Starts a bridge-hosted Claude session. The `cwd` is a path on the bridge's
     * machine, so the caller offers only project roots the bridge has already
     * served - the ones a running session proved it could reach.
     */
    fun startManagedSession(
        cwd: String,
        project: String,
        objective: String,
        prompt: String,
        permissionMode: String?,
        onResult: (Boolean, String?) -> Unit,
    ) = viewModelScope.launch {
        if (cwd.isBlank() || project.isBlank()) {
            onResult(false, "A project and a working directory are required")
            return@launch
        }
        _startingSession.value = true
        _startError.value = null
        runCatching {
            repository.startManagedSession(
                ManagedSessionRequest(
                    project = project.trim(),
                    cwd = cwd.trim(),
                    objective = objective.trim().ifBlank { null },
                    prompt = prompt.trim().ifBlank { null },
                    permissionMode = permissionMode,
                ),
            )
        }.onSuccess {
            _startingSession.value = false
            onResult(true, it.agentId)
        }.onFailure {
            _startingSession.value = false
            _startError.value = it.message ?: "Could not start the session"
            onResult(false, it.message ?: "Could not start the session")
        }
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
            // Selected chips read their fill from here. Left unset they fell
            // back to Material's default lavender - the one hue on screen that
            // belonged to no part of this palette.
            secondaryContainer = Signal.copy(alpha = 0.16f),
            onSecondaryContainer = Signal,
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
    val commandBlocked by vm.commandBlocked.collectAsStateWithLifecycle()
    val analyticsState by vm.analyticsState.collectAsStateWithLifecycle()
    val archivedAgents by vm.archivedAgents.collectAsStateWithLifecycle()
    val dismissedAgents by vm.dismissedAgents.collectAsStateWithLifecycle()
    val dismissError by vm.dismissError.collectAsStateWithLifecycle()
    val seenMarks by vm.seenMarks.collectAsStateWithLifecycle()
    var destination by rememberSaveable { mutableStateOf(DeckDestination.Agents) }
    var settingsOpen by remember { mutableStateOf(false) }
    var startOpen by remember { mutableStateOf(false) }
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
    // The completion notifier stays quiet only for the session actually on
    // screen; the deck list on screen silences nothing.
    LaunchedEffect(openAgent?.id) { ForegroundSession.openAgentId = openAgent?.id }
    if (openAgent != null) {
        // Being on this screen is what "seen" means - and staying on it keeps
        // the mark current as the session produces more. Nothing else marks:
        // the deck list, the widget and the notifiers are machine reads.
        LaunchedEffect(openAgent.id, latestActivityAt(openAgent)) { vm.markSeen(openAgent) }
        AgentSessionView(
            agent = openAgent,
            busy = busyAgent == openAgent.id,
            commandError = commandError,
            commandNotice = commandNotice,
            commandBlocked = commandBlocked?.takeIf { it.agentId == openAgent.id },
            onSendAnyway = { vm.sendAnyway(openAgent) },
            onDismiss = { selectedAgent = null },
            archived = agentArchiveKey(openAgent) in archivedAgents,
            onArchiveToggle = {
                if (agentArchiveKey(openAgent) in archivedAgents) vm.restore(openAgent) else vm.archive(openAgent)
                selectedAgent = null
            },
            onControl = { action, value -> vm.control(openAgent, action, value) },
            onQuestionAnswer = { event, answer -> vm.answerQuestion(openAgent, event, answer) },
            sessionChanges = sessionChanges[openAgent.id].orEmpty(),
            changesLoaded = sessionChanges.containsKey(openAgent.id),
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
                onStart = {
                    vm.loadManagedRuntimes()
                    startOpen = true
                },
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
                // Dismissed sessions vanish now; the stream's `removed` makes it real.
                val deckAgents = data.agents.filterNot { it.id in dismissedAgents }
                val homeNow = Instant.now()
                val deck = homeDeck(deckAgents, archivedAgents, seenMarks, homeNow)
                val sections = deck.sections(filter)
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = DeckNavSpace),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item { AgentsHeader(deck, connected = state is BridgeState.Ready, bridgeName = data.bridge.name) }
                    item {
                        Row(
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val attention = deck.attention
                            HomeFilter.entries.forEach { item ->
                                FilterChip(
                                    selected = filter == item,
                                    onClick = { filter = item },
                                    // Fully rounded. Material's default is a
                                    // softened rectangle, which reads as a
                                    // button; a filter is a pill.
                                    shape = CircleShape,
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
                    // A refused dismissal already put the card back; this says why.
                    dismissError?.let { message ->
                        item { Text("Dismiss failed · $message", color = Danger, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                    sections.forEach { section ->
                        val homeState = section.state
                        run {
                            item(key = "state:${homeState.name}") { HomeStateHeader(homeState, section.count) }
                            section.projects.forEach { group ->
                                item(key = "${homeState.name}:project:${group.project}") { ProjectGroupHeader(group.project, group.cards.map { it.agent }, showAttention = false) }
                                items(group.cards, key = { "${homeState.name}:${it.agent.id}" }) { card ->
                                    val agent = card.agent
                                    ArchivableAgentCard(
                                        agent = agent,
                                        homeState = homeState,
                                        busy = busyAgent == agent.id,
                                        archiveEnabled = filter != HomeFilter.History,
                                        onArchive = { vm.archive(agent) },
                                        onDismissSession = { vm.dismiss(agent) },
                                        onClick = { selectedAgent = agent },
                                    )
                                }
                            }
                        }
                    }
                    if (sections.isEmpty()) {
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

    if (startOpen) {
        StartSessionSheet(
            projects = snapshot?.agents?.map { it.project }?.filter { it.isNotBlank() }?.distinct() ?: emptyList(),
            workingDirectories = knownWorkingDirectories(snapshot?.agents ?: emptyList()),
            starting = vm.startingSession.collectAsStateWithLifecycle().value,
            error = vm.startError.collectAsStateWithLifecycle().value,
            onDismiss = { startOpen = false },
            onStart = { cwd, project, objective, prompt, permission, onResult ->
                vm.startManagedSession(cwd, project, objective, prompt, permission) { success, agentId ->
                    onResult(success, agentId)
                    if (success) {
                        startOpen = false
                        agentId?.let { id -> snapshot?.agents?.firstOrNull { it.id == id }?.let { selectedAgent = it } }
                    }
                }
            },
        )
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
        Box(
            modifier.padding(24.dp),
            // The skeleton stands in for content that starts at the top; centring
            // it left the screen with a header-shaped hole above it.
            contentAlignment = if (state is AnalyticsState.Failed) Alignment.Center else Alignment.TopCenter,
        ) {
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
                Text("Agent activity and spend over the past ${range.label.lowercase()}", color = Muted)
            }
        }
        item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AnalyticsRange.entries.forEach { item ->
                    FilterChip(selected = range == item, onClick = { range = item }, shape = CircleShape, label = { Text(item.label) })
                }
            }
        }
        if (data.filters.projects.isNotEmpty()) item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = project == null, onClick = { project = null }, shape = CircleShape, label = { Text("All projects") })
                data.filters.projects.forEach { name ->
                    FilterChip(selected = project == name, onClick = { project = name }, shape = CircleShape, label = { Text(name, maxLines = 1) })
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
                    // Plain, not amber: amber means something wants a person
                    // everywhere else in the deck, and a bill is not a request.
                    // Size already makes this the headline, and it leaves blue
                    // as the single accent in the card.
                    Text(formatMoney(summary.costUsd), fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.SemiBold, color = Text)
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
                Text(plural(days.sumOf { it.count }, "event"), color = Muted, fontSize = 12.sp)
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
                Text("${plural(item.sessions, "session")} · ${plural(item.events, "event")}", color = Muted, fontSize = 12.sp)
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
            // Material parks a dot at the end of the track by default. On a
            // 4dp hairline it reads as a rendering artifact, not a marker.
            drawStopIndicator = {},
        )
    }
}

@Composable
private fun RuntimeUsageCard(item: RuntimeUsage) {
    Surface(shape = RoundedCornerShape(18.dp), color = Surface, modifier = Modifier.width(150.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(item.runtime.replaceFirstChar { it.uppercase() }, color = Muted, fontSize = 12.sp)
            Text(formatCompact(item.tokens), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Blue)
            Text("${formatMoney(item.costUsd)} · ${plural(item.events, "event")}", color = Muted, fontSize = 11.sp)
        }
    }
}

/** "1 session", not "1 sessions". */
private fun plural(count: Int, singular: String, many: String = singular + "s") =
    "$count ${if (count == 1) singular else many}"

private fun formatCompact(value: Long): String = when {
    value >= 1_000_000_000 -> String.format("%.1fB", value / 1_000_000_000.0)
    value >= 1_000_000 -> String.format("%.1fM", value / 1_000_000.0)
    value >= 1_000 -> String.format("%.1fK", value / 1_000.0)
    else -> value.toString()
}.replace(".0", "")

private fun formatMoney(value: Double): String = if (value < 0.01 && value > 0) "<$0.01" else String.format("$%.2f", value)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeckTopBar(connected: Boolean, bridgeName: String, onSettings: () -> Unit, onRefresh: () -> Unit, onStart: () -> Unit) {
    TopAppBar(
        // The product's name, set like one. It used to be a 12sp all-caps
        // label with the bridge underneath, which read as a system tray rather
        // than the top of an app. What the bridge is doing moved down to the
        // line that already counts the sessions, since both answer "is this
        // thing working" and neither needs a row to itself.
        title = {
            Text(
                "Agent Deck",
                fontSize = 26.sp,
                lineHeight = 30.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.5).sp,
                color = Signal,
            )
        },
        actions = {
            IconButton(onClick = onStart) { Icon(Icons.Rounded.Add, "Start a session") }
            IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, "Refresh") }
            IconButton(onClick = onSettings) { Icon(Icons.Rounded.Tune, "Bridge settings") }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Ink.copy(alpha = 0.96f)),
        windowInsets = WindowInsets.statusBars,
    )
}

@Composable
private fun AgentsHeader(deck: HomeDeck, connected: Boolean, bridgeName: String) {
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

@Composable
private fun HomeStateHeader(state: HomeAgentState, count: Int) {
    val color = when {
        state == HomeAgentState.Failed -> Danger
        state.attention -> Amber
        state == HomeAgentState.Running -> Signal
        // Done shares completion's blue: it is the same news, just unread.
        state == HomeAgentState.Done -> Blue
        state == HomeAgentState.RecentlyCompleted -> Blue
        else -> Muted
    }
    Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 1.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(state.sectionLabel, color = color, fontSize = 10.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        Text(count.toString(), color = Muted, fontSize = 11.sp)
    }
}

/**
 * A runtime, with its own mark where one exists.
 *
 * `icon` points at the vendor's actual artwork, shared with the home screen
 * widget and the watch tile so all three draw the same thing. Pi ships no mark,
 * so its initial stands in - and the field is null rather than a placeholder
 * precisely so the drawing code can tell the difference.
 */
private enum class AgentHarness(val label: String, val color: Color, val icon: Int?) {
    Pi("Pi", Blue, null),
    Claude("Claude Code", Color(0xFFD97757), dev.agentdeck.shared.R.drawable.harness_claude),
    Codex("Codex", Text, dev.agentdeck.shared.R.drawable.harness_codex),
    OpenCode("OpenCode", Signal, dev.agentdeck.shared.R.drawable.harness_opencode),
    Gemini("Gemini CLI", Color(0xFF78A7FF), null),
    Managed("Managed Claude", Color(0xFFD97757), dev.agentdeck.shared.R.drawable.harness_claude),
    Other("Agent", Muted, null),
}

private data class ProviderIdentity(val name: String, val model: String, val color: Color)

/**
 * Which runtime a session belongs to, decided once for the whole product.
 *
 * Reading the display name missed OpenCode entirely - its sessions showed as
 * "Agent" on the phone while the widget named them correctly, because the
 * widget asked the shared derivation and this did not.
 */
private fun harnessFor(agent: Agent) = when (Harnesses.of(agent)) {
    Harness.Pi -> AgentHarness.Pi
    Harness.Claude -> AgentHarness.Claude
    Harness.Codex -> AgentHarness.Codex
    Harness.OpenCode -> AgentHarness.OpenCode
    Harness.Gemini -> AgentHarness.Gemini
    Harness.Managed -> AgentHarness.Managed
    Harness.Unknown -> AgentHarness.Other
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
        // No "Approval · " or "Question · " prefix: the status chip in the
        // card's own corner already says which of the two this is, and the
        // prefix cost a third of the line that had the detail in it.
        agent.pendingApproval?.let { return it.detail }
        agent.pendingQuestion?.let { return it.question.takeIf(String::isNotBlank) ?: "Agent has a question" }
        val latest = latestEvent(agent) { it.kind == "question" }
        if (latest != null) {
            // The summary is the question; the detail is the note explaining
            // it. Reading the detail put "Stripe retries are idempotent by key"
            // on the card and hid "Which payment provider should the retry
            // path use?" - the only part anyone can act on.
            return latest.summary.takeIf { it.isNotBlank() && !it.equals("Question", true) }
                ?: latest.detail
                ?: "Agent has a question"
        }
        return agent.task
    }
    if (agent.state == "running" || agent.state == "paused") {
        val receivedInstruction = latestEvent(agent) {
            it.kind == "thought" && it.summary == "Received instruction" && !it.detail.isNullOrBlank()
        }?.detail
        // Falling back to the last thing a person actually asked for. Without
        // it the headline restated the activity row below it verbatim -
        // "Edit finished · continuing" over "Edit finished" - and the card
        // spent two lines saying one thing.
        val lastInstruction = latestEvent(agent) { it.kind == "user" && !it.detail.isNullOrBlank() }?.detail
        val objective = agent.objective?.takeIf { it.isNotBlank() } ?: receivedInstruction ?: lastInstruction
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

/**
 * Whether the activity row would only say the headline again.
 *
 * Both are derived from `agent.task` whenever there is no instruction to show,
 * and they dress it differently - "Running Read" over "Using Read", "Grep
 * finished · continuing" over "Grep finished". Comparing the strings misses
 * that; comparing what they are about catches it.
 */
private fun restatesHeadline(headline: String, activity: String): Boolean {
    fun core(value: String) = value.lowercase()
        .substringBefore(" · ")
        .removePrefix("running ")
        .removePrefix("using ")
        .removeSuffix(" finished")
        .removeSuffix(" completed")
        .trim()
    return core(headline) == core(activity)
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
private fun ArchivableAgentCard(agent: Agent, homeState: HomeAgentState, busy: Boolean, archiveEnabled: Boolean, onArchive: () -> Unit, onDismissSession: () -> Unit, onClick: () -> Unit) {
    val content: @Composable () -> Unit = {
        if (homeState.compact) CompactAgentCard(agent, homeState, busy, onClick)
        else AgentCard(agent, homeState, busy, onClick)
    }
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
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(22.dp)).background(Danger.copy(alpha = 0.14f)).padding(start = 22.dp), contentAlignment = Alignment.CenterStart) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.DeleteOutline, "Dismiss", tint = Danger)
                        Spacer(Modifier.width(8.dp))
                        Text("Dismiss", color = Danger, fontWeight = FontWeight.SemiBold)
                    }
                }
            } else {
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(22.dp)).background(Blue.copy(alpha = 0.14f)).padding(end = 22.dp), contentAlignment = Alignment.CenterEnd) {
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

private fun homeStateColor(state: HomeAgentState) = when {
    state == HomeAgentState.Failed -> Danger
    state.attention -> Amber
    state == HomeAgentState.Running -> Signal
    // The "done" chip: completion's blue, on a full card, until it is read.
    state == HomeAgentState.Done -> Blue
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
    val headline = remember(agent.state, agent.task, agent.objective, agent.pendingApproval, agent.events) { usefulTask(agent) }
    // With no instruction to show, the headline falls back to describing the
    // current step - which is what the activity row underneath already says.
    // Show the row only when it adds something.
    val showActivity = !restatesHeadline(headline, activity)
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
                    headline,
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
            // Nothing reserved when there is nothing to draw: an empty row of
            // reserved height reads as a missing element rather than a shorter card.
            if (agent.progress != null || showActivity) Box(Modifier.fillMaxWidth().height(18.dp), contentAlignment = Alignment.CenterStart) {
                if (agent.progress != null) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        LinearProgressIndicator(
                            progress = { progress },
                            modifier = Modifier.weight(1f).height(4.dp).clip(CircleShape),
                            color = statusColor,
                            trackColor = Line,
                            drawStopIndicator = {},
                        )
                        Spacer(Modifier.width(9.dp))
                        Text("${(progress * 100).roundToInt()}%", color = Muted, fontSize = 11.sp)
                    }
                } else if (showActivity) {
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
                // Neutral, not tinted by the harness: a white mark on its own
                // pale halo is invisible, and the widget's badge is this colour.
                color = SurfaceSunken,
                modifier = Modifier.fillMaxSize(),
            ) {
                Box(contentAlignment = Alignment.Center) { AgentLogo(harness, Modifier.size(diameter * 0.58f)) }
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
    val icon = harness.icon
    if (icon != null) {
        // The vendor's own artwork rather than an approximation of it. This used
        // to draw eight radiating lines for Claude and six circles for Codex -
        // close enough to recognise, not close enough to be the mark.
        Image(painterResource(icon), harness.label, modifier)
    } else {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text(
                if (harness == AgentHarness.Pi) "π" else "··",
                color = harness.color,
                fontSize = 16.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.SemiBold,
                style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)),
            )
        }
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

/**
 * The composer: a leading mark, the field, and the button that acts on it, all
 * in one rounded container.
 *
 * The button used to sit outside, which made it look like a separate control
 * that happened to be nearby. Inside, it reads as belonging to the text it
 * sends - and the pill is the only thing that has to be sized, because
 * everything within it is measured against the same height.
 */
@Composable
private fun ComposerPill(
    modifier: Modifier = Modifier,
    leading: @Composable RowScope.() -> Unit,
    field: @Composable RowScope.() -> Unit,
    action: @Composable RowScope.() -> Unit,
) {
    Surface(
        modifier = modifier.heightIn(min = 52.dp).shadow(8.dp, CircleShape),
        shape = CircleShape,
        color = SurfaceRaised,
        border = BorderStroke(1.dp, Line),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(end = 5.dp),
        ) {
            leading()
            field()
            action()
        }
    }
}

/**
 * Send.
 *
 * It briefly held to dictate as well, which was a mistake: every Android
 * keyboard already carries a microphone, and a second one inside the app is a
 * worse copy of it that also wants a permission.
 */
@Composable
private fun ComposerSendButton(hasText: Boolean, busy: Boolean, onSend: () -> Unit) {
    FilledIconButton(
        onClick = onSend,
        enabled = hasText && !busy,
        modifier = Modifier.size(42.dp),
        shape = CircleShape,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else Icon(Icons.Rounded.ArrowUpward, "Send", modifier = Modifier.size(20.dp))
    }
}

/**
 * The text field inside a composer pill.
 *
 * Material's `TextField` reserves 56dp for a label it is never given, so a pill
 * built around one is always taller than the button beside it no matter what
 * height either is asked for. This sets its own padding, which makes the pill
 * and the send button the same size because both are told the same number.
 */
@Composable
private fun ComposerField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
    focusRequester: FocusRequester? = null,
) {
    val style = TextStyle(
        color = Text,
        fontSize = if (monospace) 14.sp else 15.sp,
        lineHeight = 20.sp,
        fontFamily = if (monospace) FontFamily.Monospace else null,
    )
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .then(focusRequester?.let { Modifier.focusRequester(it) } ?: Modifier)
            .padding(horizontal = 8.dp, vertical = 13.dp),
        textStyle = style,
        maxLines = 4,
        cursorBrush = SolidColor(Signal),
        decorationBox = { inner ->
            if (value.isEmpty()) Text(placeholder, color = Muted, style = style)
            inner()
        },
    )
}

/**
 * The radius this phone's own screen is cut to, for a panel sitting inside it.
 *
 * Asked of the device rather than guessed: corner radii differ enough between
 * handsets that a fixed number looks deliberate on one and wrong on the next.
 *
 * The inset is subtracted because concentric curves only look parallel when the
 * inner one is tighter by exactly the gap between them - matching the outer
 * radius while sitting inside it reads as too round.
 */
@Composable
private fun screenCornerRadius(inset: Dp, fallback: Dp = 28.dp): Dp {
    val view = LocalView.current
    val density = LocalDensity.current
    val radius = remember(view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@remember fallback
        val corner = view.rootWindowInsets?.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT)
        corner?.radius?.let { with(density) { it.toDp() } } ?: fallback
    }
    return (radius - inset).coerceAtLeast(8.dp)
}

/** The three dots that make a rectangle read as a window. */
@Composable
private fun WindowSemaphore() {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        for (colour in listOf(Color(0xFFFF5F57), Color(0xFFFEBC2E), Color(0xFF28C840))) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(colour))
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

@Composable
private fun AgentSessionView(agent: Agent, busy: Boolean, commandError: String?, commandNotice: String?, commandBlocked: BlockedCommand?, onSendAnyway: () -> Unit, onDismiss: () -> Unit, archived: Boolean, onArchiveToggle: () -> Unit, onControl: (String, String?) -> Unit, onQuestionAnswer: (AgentEvent, String) -> Unit, sessionChanges: List<AgentEvent>, changesLoaded: Boolean, onLoadChanges: () -> Unit, sessionHistory: List<AgentEvent>, onLoadHistory: () -> Unit, slashCommands: List<SlashCommand>, onLoadSlashCommands: () -> Unit) {
    // The session is one conversation. Everything the agent did reads inline
    // as work between the words; depth — a command's output, a file's diff,
    // the session's changed files — opens as a sheet over the same screen
    // rather than as somewhere else to be.
    var openActivity by remember(agent.id) { mutableStateOf<AgentEvent?>(null) }
    var changesOpen by rememberSaveable(agent.id) { mutableStateOf(false) }
    var confirmingStop by rememberSaveable(agent.id) { mutableStateOf(false) }
    val supports: (String) -> Boolean = { action -> supportsCapability(agent.capabilities, action) }
    val pendingApproval = agent.pendingApproval?.takeIf { agent.state == "waiting" }
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
    val pendingQuestion = latestEvent(sessionAgent) { it.kind == "question" }?.takeIf { agent.state == "waiting" }
    val harness = harnessFor(agent)
    val provider = providerFor(agent)
    val stateColor = statusColor(agent.state)
    val activity = remember(agent.state, agent.task, agent.objective, agent.pendingApproval, agent.events) { agentCardActivity(agent) }
    // Prefer the bridge's full history; fall back to whatever the live window still holds while it loads.
    val fileChanges = remember(sessionChanges) { agentFileChanges(sessionChanges) }
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
                                Text(
                                    activeRun?.title ?: agent.project,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    color = if (activeRun != null) Blue else Text,
                                )
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
                    HeaderPill {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val pauseAction = if (isPaused) "resume" else "pause"
                            if (supports(pauseAction)) IconButton(onClick = { onControl(pauseAction, null) }, enabled = !busy, modifier = Modifier.size(40.dp)) {
                                Icon(if (isPaused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause, if (isPaused) "Resume agent" else "Pause agent", tint = Text, modifier = Modifier.size(20.dp))
                            }
                            if (supports("stop")) IconButton(onClick = { confirmingStop = true }, enabled = !busy, modifier = Modifier.size(40.dp)) {
                                Icon(Icons.Rounded.Stop, "Stop agent", tint = Danger, modifier = Modifier.size(20.dp))
                            }
                            IconButton(onClick = onArchiveToggle, modifier = Modifier.size(40.dp)) {
                                Icon(
                                    if (archived) Icons.Rounded.Unarchive else Icons.Rounded.Archive,
                                    if (archived) "Restore session" else "Archive session",
                                    tint = Muted,
                                    modifier = Modifier.size(19.dp),
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
                changedFiles = fileChanges.size,
                onOpenChanges = { changesOpen = true },
                modifier = Modifier.weight(1f),
            )
        }
    }
    openActivity?.let { event ->
        ActivityDetailSheet(event, onDismiss = { openActivity = null })
    }
    if (changesOpen) {
        ChangesSheet(fileChanges, changesLoaded, onDismiss = { changesOpen = false })
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

/**
 * Which subagent to read, or the whole session.
 *
 * A list rather than a switch, because a session can be running several at
 * once and they are told apart by what they are doing, not by their ids.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubagentPicker(
    runs: List<SubagentRun>,
    selected: String?,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    // Chosen once per opening: the sheet lands on the running work when there
    // is any, and the person takes it from there.
    var filter by remember { mutableStateOf(defaultSubagentFilter(runs)) }
    val running = runs.count { !it.finished }
    val done = runs.size - running
    val shown = filteredSubagentRuns(runs, filter, selected)
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Text("Subagents", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(3.dp))
            Text(
                "Work this session handed to an agent of its own.",
                color = Muted,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
            Spacer(Modifier.height(10.dp))
            SubagentRow(
                title = "Whole session",
                subtitle = "Everything, including this session's own work",
                tint = Signal,
                running = false,
                selected = selected == null,
            ) { onPick(null) }
            // The chips carry counts so filtering is informed before a tap;
            // they only appear once both statuses exist to filter between.
            if (running > 0 && done > 0) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SubagentFilterChip("Running $running", filter == SubagentFilter.Running) {
                        filter = SubagentFilter.Running
                    }
                    SubagentFilterChip("Done $done", filter == SubagentFilter.Done) {
                        filter = SubagentFilter.Done
                    }
                    SubagentFilterChip("All ${runs.size}", filter == SubagentFilter.All) {
                        filter = SubagentFilter.All
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            // A busy session runs more lenses than a sheet is tall. The list
            // scrolls under the fixed header; `fill = false` keeps a short
            // list from stretching the sheet past its content.
            LazyColumn(
                modifier = Modifier.weight(1f, fill = false),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(shown, key = { it.id }) { run ->
                    SubagentRow(
                        title = run.title,
                        subtitle = run.activity,
                        tint = Blue,
                        running = !run.finished,
                        selected = selected == run.id,
                    ) { onPick(run.id) }
                }
            }
        }
    }
}

@Composable
private fun SubagentFilterChip(label: String, active: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(99.dp),
        color = if (active) Blue.copy(alpha = 0.15f) else SurfaceRaised,
        border = BorderStroke(1.dp, if (active) Blue.copy(alpha = 0.45f) else Line),
    ) {
        Text(
            label,
            color = if (active) Text else Muted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun SubagentRow(
    title: String,
    subtitle: String,
    tint: Color,
    running: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        color = if (selected) tint.copy(alpha = 0.13f) else SurfaceRaised,
        border = if (selected) BorderStroke(1.dp, tint.copy(alpha = 0.4f)) else null,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(if (running) tint else Muted.copy(alpha = 0.5f)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Text(subtitle, color = Muted, fontSize = 12.sp, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (selected) {
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Rounded.Check, "Showing this", tint = tint, modifier = Modifier.size(18.dp))
            }
        }
    }
}

/** The day a run of messages belongs to, floating over the conversation. */
@Composable
private fun TurnSeparator() {
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.fillMaxWidth(0.42f).height(1.dp).background(Line))
    }
}

@Composable
private fun DaySeparator(label: String) {
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

/** One floating piece of the header, lifted off the conversation behind it. */
@Composable
private fun HeaderPill(
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

/** A line above the composer, legible over whatever the conversation put behind it. */
@Composable
private fun FloatingNotice(text: String, tint: Color) {
    Surface(
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 3.dp),
        shape = RoundedCornerShape(10.dp),
        color = SurfaceRaised,
        border = BorderStroke(1.dp, Line),
    ) {
        Text(
            text,
            color = tint,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

/**
 * The bridge's refusal to message a blocked session, in the session's own amber.
 *
 * It carries the bridge's sentence about what is pending, points at the
 * approval or question card that owns the block, and offers the one explicit
 * way past it. The refused words are already back in the field below.
 */
@Composable
private fun BlockedSendNotice(detail: String, onSendAnyway: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 3.dp),
        shape = RoundedCornerShape(14.dp),
        color = Amber.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, Amber.copy(alpha = 0.24f)),
    ) {
        Column(Modifier.padding(start = 12.dp, end = 6.dp, top = 8.dp, bottom = 2.dp)) {
            Text(detail, color = Amber, fontSize = 12.sp, lineHeight = 17.sp)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Answer the pending card above first.",
                    color = Muted,
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onSendAnyway) { Text("Send anyway", fontSize = 12.sp) }
            }
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
    changedFiles: Int = 0,
    onOpenChanges: () -> Unit = {},
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
            itemsIndexed(entries, key = { _, item -> "item:${item.leadEvent.id}" }) { index, item ->
                // A session open since yesterday reads as one unbroken run, and
                // the stamps only give the hour - "09:14" under "23:47" looks
                // like four minutes, not ten hours.
                ConversationDays
                    .separatorBefore(entries.getOrNull(index - 1)?.newestEvent?.createdAt, item.leadEvent.createdAt)
                    ?.let { DaySeparator(it) }
                // A hairline where a new exchange begins, so a long session
                // reads as threads rather than one unbroken run.
                if (index > 0 && startsNewTurn(entries[index - 1].newestEvent, item.leadEvent)) TurnSeparator()
                when (item) {
                    is TimelineItem.Message -> ConversationBubble(item.entry, providerFor(agent))
                    is TimelineItem.Activity -> ActivityCluster(
                        events = item.events,
                        // The last run of a working session is the one being
                        // written; it arrives open so the work is watchable.
                        live = working && index == entries.lastIndex,
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
                    // The session's receipt: what all that work touched, one
                    // quiet line where a conversation would leave one.
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable(onClick = onOpenChanges)
                            .padding(horizontal = 6.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Rounded.Difference, null, tint = Muted, modifier = Modifier.size(15.dp))
                        Spacer(Modifier.width(7.dp))
                        Text(
                            if (changedFiles == 1) "1 file changed" else "$changedFiles files changed",
                            color = Muted,
                            fontSize = 12.sp,
                        )
                        Spacer(Modifier.weight(1f))
                        Icon(Icons.Rounded.ChevronRight, null, tint = Muted.copy(alpha = 0.7f), modifier = Modifier.size(16.dp))
                    }
                }
                if (working) item(key = "working") {
                    WorkingIndicator(agent.task)
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
        MessageComposer(agent, busy, commandError, commandNotice, commandBlocked, onSendAnyway, supports, slashCommands, onControl, autoFocus, lensed)
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
private fun EmptyConversation(supportsMessaging: Boolean, lensed: Boolean = false) {
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

/**
 * A run of work between words, folded to one quiet line.
 *
 * Collapsed, it says what the run amounted to — "14 steps · Edit, Bash ·
 * 3 files" — because the words around it are what a conversation is for.
 * Tapped, it opens into the steps themselves, each one line, each openable
 * where there is a command, a diff, or words behind it. The live run of a
 * working session arrives already open at its tail, so the work is
 * watchable as it happens without anyone asking.
 */
@Composable
private fun ActivityCluster(events: List<AgentEvent>, live: Boolean, onOpen: (AgentEvent) -> Unit) {
    var expanded by rememberSaveable(events.first().id) { mutableStateOf(false) }
    val shown = when {
        expanded -> events
        live -> events.takeLast(3)
        else -> emptyList()
    }
    Column(Modifier.fillMaxWidth().padding(end = 40.dp)) {
        Row(
            Modifier
                .clip(RoundedCornerShape(9.dp))
                .clickable { expanded = !expanded }
                .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Bolt, null, tint = Muted, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(7.dp))
            Text(activitySummary(events), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.width(4.dp))
            Icon(
                if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                if (expanded) "Collapse steps" else "Expand steps",
                tint = Muted.copy(alpha = 0.7f),
                modifier = Modifier.size(15.dp),
            )
        }
        if (shown.isNotEmpty()) Row(Modifier.padding(start = 12.dp)) {
            Box(Modifier.width(1.dp).fillMaxHeight().background(Line))
            Column(Modifier.padding(start = 10.dp)) {
                if (!expanded && live && events.size > shown.size) {
                    Text(
                        "${events.size - shown.size} earlier steps",
                        color = Muted.copy(alpha = 0.6f),
                        fontSize = 11.sp,
                        modifier = Modifier.padding(vertical = 3.dp),
                    )
                }
                shown.forEach { event -> ActivityRow(event, onOpen) }
            }
        }
    }
}

@Composable
private fun ActivityRow(event: AgentEvent, onOpen: (AgentEvent) -> Unit) {
    val openable = !event.command.isNullOrBlank() || !event.diff.isNullOrBlank() || !event.detail.isNullOrBlank()
    val failed = event.kind == "error"
    val icon = when {
        event.kind == "thought" -> Icons.Rounded.Psychology
        failed || event.kind == "warning" -> Icons.Rounded.WarningAmber
        !event.command.isNullOrBlank() -> Icons.Rounded.Terminal
        !event.diff.isNullOrBlank() || event.path != null -> Icons.Rounded.Difference
        else -> Icons.Rounded.Build
    }
    // A thought's first words are the row; everything else leads with what it did.
    val line = if (event.kind == "thought") {
        event.detail.orEmpty().lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: event.summary
    } else {
        event.summary
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(7.dp))
            .clickable(enabled = openable) { onOpen(event) }
            .padding(horizontal = 4.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (failed) Danger else Muted.copy(alpha = 0.8f), modifier = Modifier.size(13.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            line,
            color = if (failed) Danger else Text.copy(alpha = 0.72f),
            fontSize = 12.sp,
            fontStyle = if (event.kind == "thought") FontStyle.Italic else FontStyle.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (openable) {
            Spacer(Modifier.width(5.dp))
            Icon(Icons.Rounded.ChevronRight, null, tint = Muted.copy(alpha = 0.55f), modifier = Modifier.size(13.dp))
        }
    }
}

/** The agent is typing — three quiet dots and what it is on, messaging's own idiom for "working". */
@Composable
private fun WorkingIndicator(task: String) {
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
private fun ActivityDetailSheet(event: AgentEvent, onDismiss: () -> Unit) {
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

/** Every file the session touched, as a sheet over the conversation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChangesSheet(files: List<AgentFileChange>, loaded: Boolean, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        DiffView(files, loaded, Modifier.fillMaxWidth().heightIn(max = 560.dp))
    }
}

@Composable
private fun MessageComposer(agent: Agent, busy: Boolean, commandError: String?, commandNotice: String?, commandBlocked: BlockedCommand?, onSendAnyway: () -> Unit, supports: (String) -> Boolean, slashCommands: List<SlashCommand>, onControl: (String, String?) -> Unit, autoFocus: Boolean, lensed: Boolean = false) {
    var message by rememberSaveable(agent.id) { mutableStateOf("") }
    // A refused message is not a sent one: the words come back into the field
    // so the draft survives the refusal, exactly as typed.
    LaunchedEffect(commandBlocked) {
        if (commandBlocked != null && message.isBlank()) message = commandBlocked.value.orEmpty()
    }
    val composerFocus = remember { FocusRequester() }
    // Switching to a view that can be typed into means wanting to type into it.
    // Arriving at the session does not - so this waits for a deliberate tab
    // choice rather than firing on first composition. Guarded because the node
    // is not attached on the first frame, and a focus request against nothing
    // throws rather than waiting.
    LaunchedEffect(Unit) { if (autoFocus) runCatching { composerFocus.requestFocus() } }
    val action = remoteMessageAction(agent.state, supports)
    if (action == null) {
        Text("This runtime does not accept remote messages.", color = Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(16.dp))
        return
    }
    val query = slashCommandQuery(message)
    val matches = remember(query, slashCommands) { query?.let { matchSlashCommands(it, slashCommands) }.orEmpty() }
    // Floating: no bar across the bottom. The composer sits on the conversation
    // with air around it, so the chat reads as continuing underneath rather than
    // stopping at a wall.
    Box(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 10.dp, vertical = 8.dp)) {
            if (matches.isNotEmpty()) SlashCommandPicker(matches) { message = "/${it.name} " }
            else if (query != null && slashCommands.isEmpty()) {
                Text("No commands reported by this runtime.", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
            }
            // Over the conversation now, so each notice carries its own ground.
            commandBlocked?.let { BlockedSendNotice(it.detail, onSendAnyway) }
            if (commandBlocked == null) commandError?.let { FloatingNotice(it, Danger) }
            if (commandBlocked == null && commandError == null) commandNotice?.let { FloatingNotice(it, Muted) }
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
            ) {
            // One rounded field, the way every messaging app draws one. The
            // outlined variant put a visible box inside a raised bar - two
            // borders around the same thing - and the slash button lives inside
            // it because it acts on what is being typed, not on the session.
            // One pill holding everything, the way a messaging composer is
            // drawn: the button belongs to the field it acts on, not beside it.
            ComposerPill(
                modifier = Modifier.weight(1f),
                leading = {
                    IconButton(
                        onClick = { message = if (message.startsWith("/")) message else "/$message" },
                        modifier = Modifier.size(40.dp),
                    ) {
                        Icon(
                            Icons.Rounded.Bolt,
                            "Slash command",
                            tint = if (message.startsWith("/")) Signal else Muted,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
                field = {
                    // BasicTextField, not TextField: the material one carries a
                    // 56dp minimum of its own, which made the pill taller than
                    // whatever sat next to it. Here the padding is the height.
                    ComposerField(
                        value = message,
                        onValueChange = { message = it },
                        placeholder = when {
                            // Under a lens the field is still the session's.
                            lensed -> "Message the session…"
                            action == "steer" -> "Reply or steer…  / commands  ! shell"
                            else -> "Message agent…  / commands  ! shell"
                        },
                        modifier = Modifier.weight(1f),
                        focusRequester = composerFocus,
                    )
                },
                action = {
                    ComposerSendButton(
                        hasText = message.isNotBlank(),
                        busy = busy,
                        onSend = {
                            val content = message.trim()
                            // `!` is the terminal living in the composer: the
                            // rest of the line goes to the runtime as an exact
                            // shell command, the way the Terminal tab used to
                            // send one.
                            val shell = content.removePrefix("!").trim()
                                .takeIf { content.startsWith("!") && it.isNotBlank() }
                            onControl(action, shell?.let(::terminalCommandInstruction) ?: content)
                            message = ""
                        },
                    )
                },
            )
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
            // Claiming "0 files changed" while the fetch is still in flight
            // states a result the screen does not have yet. The body says it is
            // loading; this bar just holds the count until there is one.
            Text(
                if (!loaded && files.isEmpty()) "Changes" else "${plural(files.size, "file")} changed",
                color = Text.copy(alpha = 0.86f),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
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
private fun TerminalCommandComposer(
    agent: Agent,
    busy: Boolean,
    commandError: String?,
    commandNotice: String?,
    commandBlocked: BlockedCommand?,
    onSendAnyway: () -> Unit,
    supports: (String) -> Boolean,
    onControl: (String, String?) -> Unit,
) {
    val action = remoteMessageAction(agent.state, supports) ?: return
    var command by rememberSaveable(agent.id) { mutableStateOf("") }
    val composerFocus = remember { FocusRequester() }

    // Not a pill. A terminal's prompt is a line at the bottom of the window,
    // flush with the scrollback above it - a floating rounded field inside a
    // terminal window is a chat box wearing a monospace font.
    var focused by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding()) {
        // The refused instruction rides in commandBlocked and "Send anyway"
        // resends it verbatim, so the prompt line itself stays untouched.
        commandBlocked?.let { BlockedSendNotice(it.detail, onSendAnyway) }
        if (commandBlocked == null) commandError?.let { FloatingNotice(it, Danger) }
        if (commandBlocked == null && commandError == null) commandNotice?.let { FloatingNotice(it, Muted) }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF080B0E))
                .padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "\$",
                color = Signal,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
            )
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f).onFocusChanged { focused = it.isFocused }) {
                ComposerField(
                    value = command,
                    onValueChange = { command = it },
                    placeholder = "",
                    monospace = true,
                    focusRequester = composerFocus,
                )
                // The caret only stands in while the field is not focused; once
                // it is, the text field draws a real one, and two cursors on a
                // prompt is worse than none. It rests where an empty prompt's
                // cursor rests — at the start, right after the $.
                if (!focused && command.isEmpty()) {
                    BlinkingCaret(Signal, Modifier.align(Alignment.CenterStart))
                }
            }
            ComposerSendButton(
                hasText = command.isNotBlank(),
                busy = busy,
                onSend = {
                    onControl(action, terminalCommandInstruction(command.trim()))
                    command = ""
                },
            )
        }
    }
}

private suspend fun LazyListState.scrollToEnd(lastItem: Int) {
    withFrameNanos { }
    scrollToItem(lastItem)
    scrollBy(Float.MAX_VALUE)
}

private val messageTimeFormatter = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
private fun formatMessageTime(value: String): String = runCatching { messageTimeFormatter.format(Instant.parse(value)) }.getOrDefault(value.substringAfter('T').take(5))

@Composable
private fun QuestionCard(event: AgentEvent, answerable: Boolean, busy: Boolean, onAnswer: (String) -> Unit) {
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
                    label = { Text("Pairing code or token") },
                    // The raw-token route has always worked - six digits pairs,
                    // anything else is used as the token - and nothing said so.
                    // It is the one that does not expire, so it is worth naming.
                    supportingText = {
                        Text(error ?: "Six digits to pair, or paste a bridge token. Blank keeps this device's.")
                    },
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

/**
 * Start a bridge-hosted Claude session from the phone.
 *
 * The `cwd` is a path on the bridge's machine, not this one, so it is typed
 * rather than browsed: a person knows their own project roots, and the bridge
 * is the one that has to find the directory. The project names already on the
 * deck are offered as completions, because they are the work this bridge runs.
 */
@Composable
private fun StartSessionSheet(
    projects: List<String>,
    workingDirectories: List<String>,
    starting: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onStart: (cwd: String, project: String, objective: String, prompt: String, permissionMode: String?, (Boolean, String?) -> Unit) -> Unit,
) {
    var project by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("") }
    var objective by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var permission by remember { mutableStateOf("default") }
    var fieldError by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!starting) onDismiss() },
        icon = { Icon(Icons.Rounded.PlayCircle, null, tint = Signal) },
        title = { Text("Start a session") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("The bridge runs this session itself, so it stays on when no terminal is watching.", color = Muted)
                OutlinedTextField(
                    value = project,
                    onValueChange = { project = it; fieldError = null },
                    label = { Text("Project") },
                    singleLine = true,
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                )
                // The project names this bridge already serves, as quick fills.
                if (projects.isNotEmpty()) {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        projects.take(8).forEach { name ->
                            AssistChip(
                                onClick = { if (!starting) project = name; fieldError = null },
                                label = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                shape = CircleShape,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it; fieldError = null },
                    label = { Text("Working directory") },
                    placeholder = { Text("/absolute/path/on/the/bridge", color = Muted.copy(alpha = 0.6f)) },
                    singleLine = true,
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                    supportingText = { Text("An absolute path on the bridge's machine.") },
                )
                // The directories the bridge has already run sessions in, most
                // recent first - tapping one fills the field, typing still works.
                if (workingDirectories.isNotEmpty()) {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        workingDirectories.take(8).forEach { path ->
                            AssistChip(
                                onClick = { if (!starting) cwd = path; fieldError = null },
                                label = { Text(workingDirectoryLabel(path), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                shape = CircleShape,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = objective,
                    onValueChange = { objective = it },
                    label = { Text("Objective") },
                    placeholder = { Text("What this session is for", color = Muted.copy(alpha = 0.6f)) },
                    singleLine = true,
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                )
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = { Text("First message") },
                    placeholder = { Text("Sent the moment the session starts", color = Muted.copy(alpha = 0.6f)) },
                    enabled = !starting,
                    shape = RoundedCornerShape(14.dp),
                    minLines = 1,
                    maxLines = 4,
                )
                Text("Permission mode", fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp, color = Muted)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ManagedPermission.entries.forEach { mode ->
                        FilterChip(
                            selected = permission == mode.wire,
                            onClick = { if (!starting) permission = mode.wire },
                            shape = CircleShape,
                            label = { Text(mode.label) },
                        )
                    }
                }
                if (fieldError != null || error != null) {
                    Text(fieldError ?: error ?: "", color = Danger, fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (project.isBlank() || cwd.isBlank()) {
                        fieldError = "A project and a working directory are required"
                        return@Button
                    }
                    if (!cwd.startsWith("/")) {
                        fieldError = "The working directory must be an absolute path"
                        return@Button
                    }
                    onStart(cwd, project, objective, prompt, permission) { success, message ->
                        if (!success) fieldError = message
                    }
                },
                enabled = !starting,
            ) {
                if (starting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("Start")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !starting) { Text("Cancel") } },
        containerColor = SurfaceRaised,
    )
}

private enum class ManagedPermission(val wire: String, val label: String) {
    Default("default", "Ask"),
    AcceptEdits("acceptEdits", "Auto-edit"),
    Plan("plan", "Plan"),
    Auto("auto", "Auto"),
}

@Composable
private fun EmptyBridge(state: BridgeState, onConfigure: () -> Unit, onRetry: () -> Unit) {
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
