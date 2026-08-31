package dev.agentdeck.mobile

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.RoundedCorner
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.agentdeck.shared.*
import dev.agentdeck.shared.deliveryNotice
import java.time.Instant
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch




/** Darker than the bar it sits in, so the composer reads as a well. */








class MainActivity : ComponentActivity() {
    private val deckViewModel by viewModels<DeckViewModel>()
    private var targetAgentId by mutableStateOf<String?>(null)
    private var targetPairing by mutableStateOf<PairingLink?>(null)

    private fun consumeLink(intent: Intent) {
        targetAgentId = intent.data?.takeIf { it.scheme == "agentdeck" && it.host == "agent" }?.lastPathSegment
        targetPairing = intent.data?.takeIf { it.scheme == "agentdeck" && it.host == "pair" }
            ?.let { parsePairingLink(it.toString()) }
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startBridgeMonitor()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        consumeLink(intent)
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
        setContent {
            AgentDeckTheme {
                AgentDeckApp(
                    targetAgentId,
                    onTargetConsumed = { targetAgentId = null },
                    pairing = targetPairing,
                    onPairingConsumed = { targetPairing = null },
                    vm = deckViewModel,
                )
            }
        }
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
        consumeLink(intent)
    }

    private fun startBridgeMonitor() {
        ContextCompat.startForegroundService(this, Intent(this, BridgeMonitorService::class.java))
    }
}

/** Actions that carry words for the model, as opposed to a control decision. */
internal val MESSAGE_ACTIONS = setOf("prompt", "steer", "follow_up")

/**
 * A message the bridge refused because the session is blocked on a person.
 *
 * Holds everything a "Send anyway" needs to resend verbatim, plus the
 * bridge's own sentence about what is pending. `at` exists so a second
 * identical refusal still reads as a new event to the composer.
 */
/**
 * What became of one Agent's last Command, and whose it was.
 *
 * The error and the notice used to be bare strings held for the whole deck,
 * so a Command that failed on one Agent surfaced its line in whatever
 * session was opened next. `BlockedCommand` already carried its `agentId`
 * for exactly this reason; the other two feedback lines now do the same.
 */
internal data class CommandFeedback(val agentId: String, val message: String)

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
    private val _commandError = MutableStateFlow<CommandFeedback?>(null)
    internal val commandError = _commandError.asStateFlow()
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

    private val _sessionModels = MutableStateFlow<Map<String, List<RuntimeModel>>>(emptyMap())

    /** What each hosted session can be switched to; empty for a runtime-owned one. */
    internal val sessionModels = _sessionModels.asStateFlow()

    fun loadModels(agentId: String) = viewModelScope.launch {
        runCatching { repository.models(agentId) }
            .onSuccess { models -> _sessionModels.value = _sessionModels.value + (agentId to models) }
    }

    private val _queuedMessages = MutableStateFlow<Map<String, List<QueuedCommand>>>(emptyMap())
    val queuedMessages = _queuedMessages.asStateFlow()

    fun loadQueued(agentId: String) = viewModelScope.launch {
        runCatching { repository.queuedMessages(agentId) }
            .onSuccess { queue -> _queuedMessages.value = _queuedMessages.value + (agentId to queue) }
    }

    fun cancelQueued(agentId: String, commandId: String) = viewModelScope.launch {
        runCatching { repository.cancelQueued(agentId, commandId) }
        loadQueued(agentId)
    }

    private val _commandNotice = MutableStateFlow<CommandFeedback?>(null)

    /** What became of the last message: set only when it did not simply go through. */
    internal val commandNotice = _commandNotice.asStateFlow()

    private val _commandBlocked = MutableStateFlow<BlockedCommand?>(null)

    /** The last message the bridge refused for a blocked session, until resolved or resent. */
    internal val commandBlocked = _commandBlocked.asStateFlow()

    fun control(agent: Agent, action: String, value: String? = null, force: Boolean = false) = viewModelScope.launch {
        _commandInFlight.value = agent.id
        _commandBlocked.value = null
        // One id per logical send: the bridge dedupes on it, so a transport
        // retry (OkHttp re-sends some POSTs on connection failure) can never
        // queue the same instruction twice.
        val commandId = java.util.UUID.randomUUID().toString()
        runCatching { repository.control(agent.id, action, value, commandId = commandId, force = force) }
            .onSuccess {
                _commandError.value = null
                // The bridge accepting a message is not the session receiving
                // it. Say which happened, rather than leaving silence to be
                // read as delivery.
                _commandNotice.value = deliveryNotice(agent.state)
                    ?.takeIf { action in MESSAGE_ACTIONS }
                    ?.let { CommandFeedback(agent.id, it) }
                if (action in MESSAGE_ACTIONS) loadQueued(agent.id)
            }
            .onFailure {
                // A blocked refusal keeps the words: the draft goes back into
                // the composer with the bridge's reason beside it, instead of
                // vanishing into a generic error line.
                if (it is AgentBlockedException && action in MESSAGE_ACTIONS) {
                    _commandBlocked.value = BlockedCommand(agent.id, action, value, it.message ?: "This agent is waiting on an approval or question.")
                    _commandError.value = null
                } else {
                    _commandError.value =
                        CommandFeedback(agent.id, it.message ?: "Command delivery failed")
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
internal fun AgentDeckTheme(content: @Composable () -> Unit) {
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

internal enum class DeckDestination { Agents, Usage }

/** Room a scrolling screen leaves so its last item can clear the floating bar. */
internal val DeckNavSpace = 104.dp

@Composable
internal fun DeckBottomBar(selected: DeckDestination, onSelect: (DeckDestination) -> Unit, modifier: Modifier = Modifier) {
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
internal fun DeckNavItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
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

/** The three dots that make a rectangle read as a window. */
@Composable
internal fun WindowSemaphore() {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        for (colour in listOf(Color(0xFFFF5F57), Color(0xFFFEBC2E), Color(0xFF28C840))) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(colour))
        }
    }
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
internal fun screenCornerRadius(inset: Dp, fallback: Dp = 28.dp): Dp {
    val view = LocalView.current
    val density = LocalDensity.current
    val radius = remember(view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@remember fallback
        val corner = view.rootWindowInsets?.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT)
        corner?.radius?.let { with(density) { it.toDp() } } ?: fallback
    }
    return (radius - inset).coerceAtLeast(8.dp)
}

@Composable
internal fun AgentDeckApp(
    targetAgentId: String? = null,
    onTargetConsumed: () -> Unit = {},
    pairing: PairingLink? = null,
    onPairingConsumed: () -> Unit = {},
    vm: DeckViewModel = viewModel(),
) {
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
    // A scanned pairing QR is the whole ceremony: address and one-time code
    // arrive together, so connect without anyone typing either. A code that
    // failed (expired, already used) opens the connection dialog with the
    // address kept, so the person only has to mint a fresh code.
    LaunchedEffect(pairing) {
        if (pairing != null) {
            onPairingConsumed()
            vm.saveConnection(pairing.url, pairing.code) { success, _ ->
                if (!success) settingsOpen = true
            }
        }
    }

    val sessionChanges by vm.sessionChanges.collectAsStateWithLifecycle()
    val queuedMessages by vm.queuedMessages.collectAsStateWithLifecycle()
    val sessionModels by vm.sessionModels.collectAsStateWithLifecycle()
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
        // The reader's mark, frozen at open — the LaunchedEffect below moves
        // it, and the "New" divider must point at where it stood before.
        val seenUpTo = remember(openAgent.id) {
            maxOf(seenMarks[openAgent.id] ?: "", openAgent.viewedAt ?: "").ifBlank { null }
        }
        LaunchedEffect(openAgent.id, latestActivityAt(openAgent)) { vm.markSeen(openAgent) }
        AgentSessionView(
            agent = openAgent,
            busy = busyAgent == openAgent.id,
            commandError = commandError?.takeIf { it.agentId == openAgent.id }?.message,
            commandNotice = commandNotice?.takeIf { it.agentId == openAgent.id }?.message,
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
            queuedMessages = queuedMessages[openAgent.id].orEmpty(),
            onLoadQueued = { vm.loadQueued(openAgent.id) },
            onCancelQueued = { commandId -> vm.cancelQueued(openAgent.id, commandId) },
            seenUpTo = seenUpTo,
            models = sessionModels[openAgent.id].orEmpty(),
            onLoadModels = { vm.loadModels(openAgent.id) },
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
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = DeckNavSpace),
                ) {
                    item { AgentsHeader(deck, connected = state is BridgeState.Ready, bridgeName = data.bridge.name) }
                    item {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp).horizontalScroll(rememberScrollState()),
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
                        item { Box(Modifier.padding(vertical = 4.dp)) { OfflineBanner((state as BridgeState.Failed).message) } }
                    }
                    // A refused dismissal already put the card back; this says why.
                    dismissError?.let { message ->
                        item { Text("Dismiss failed · $message", color = Danger, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(vertical = 4.dp)) }
                    }
                    // A chat list, not a dashboard: one flat run of sessions in
                    // the deck's own priority order, each reading as a
                    // conversation — who, the last thing said, when. The state
                    // taxonomy still orders the list; the rows wear it as
                    // colour and badges instead of section furniture.
                    val rows = deck.cards.filter { filter.includes(it.state) }
                    itemsIndexed(rows, key = { _, card -> card.agent.id }) { index, card ->
                        val agent = card.agent
                        Column {
                            ArchivableAgentCard(
                                agent = agent,
                                homeState = card.state,
                                busy = busyAgent == agent.id,
                                archiveEnabled = filter != HomeFilter.History,
                                onArchive = { vm.archive(agent) },
                                onDismissSession = { vm.dismiss(agent) },
                                onClick = { selectedAgent = agent },
                            )
                            if (index < rows.lastIndex) {
                                HorizontalDivider(
                                    color = Line,
                                    thickness = 0.6.dp,
                                    modifier = Modifier.padding(start = 68.dp),
                                )
                            }
                        }
                    }
                    if (rows.isEmpty()) {
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeckTopBar(connected: Boolean, bridgeName: String, onSettings: () -> Unit, onRefresh: () -> Unit, onStart: () -> Unit) {
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
