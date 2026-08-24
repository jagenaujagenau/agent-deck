package dev.agentdeck.shared

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.TimeZone
import java.util.concurrent.TimeUnit

class BridgeClient(
    baseUrl: String,
    private var token: String = "",
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val streamHttp = http.newBuilder()
        .readTimeout(0, TimeUnit.SECONDS)
        .build()
    @Volatile private var activeStreamCall: Call? = null

    var baseUrl: String = normalizeUrl(baseUrl)
        private set

    fun configure(url: String, newToken: String) {
        baseUrl = normalizeUrl(url)
        token = newToken.trim()
    }

    suspend fun snapshot(): BridgeSnapshot = withContext(Dispatchers.IO) {
        val request = requestBuilder("$baseUrl/bridge/v1/snapshot").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Bridge returned ${response.code}")
            json.decodeFromString<BridgeSnapshot>(response.body.string())
        }
    }

    /**
     * Every file change a session produced. The live snapshot carries only a rolling window of
     * events, so a long session's earlier edits are not in it — the Changes tab loads them here.
     */
    suspend fun changes(agentId: String): List<AgentEvent> = withContext(Dispatchers.IO) {
        val request = requestBuilder("$baseUrl/bridge/v1/agents/$agentId/changes").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Bridge returned ${response.code}")
            json.decodeFromString<AgentChanges>(response.body.string()).changes
        }
    }

    /**
     * A session's retained history. The live snapshot only carries a rolling window sized for
     * cards, so on a busy session the conversation, reasoning and terminal output all age out of
     * it — the session view reads them here instead.
     */
    suspend fun history(agentId: String): List<AgentEvent> = withContext(Dispatchers.IO) {
        val request = requestBuilder("$baseUrl/bridge/v1/agents/$agentId/history").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Bridge returned ${response.code}")
            json.decodeFromString<AgentHistory>(response.body.string()).events
        }
    }

    /** What this session can be asked to run by name, for the composer's "/" picker. */
    suspend fun slashCommands(agentId: String): List<SlashCommand> = withContext(Dispatchers.IO) {
        val request = requestBuilder("$baseUrl/bridge/v1/agents/$agentId/slash-commands").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Bridge returned ${response.code}")
            json.decodeFromString<SlashCommandCatalog>(response.body.string()).commands
        }
    }

    suspend fun streamSnapshots(onSnapshot: (BridgeSnapshot) -> Unit) = withContext(Dispatchers.IO) {
        val request = requestBuilder("$baseUrl/bridge/v1/events")
            .header("Accept", "text/event-stream")
            .get()
            .build()
        val call = streamHttp.newCall(request)
        activeStreamCall = call
        call.execute().use { response ->
            if (!response.isSuccessful) error("Event stream returned ${response.code}")
            val source = response.body.source()
            var eventName = ""
            var latest: BridgeSnapshot? = null
            val data = StringBuilder()
            while (currentCoroutineContext().isActive && !source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.startsWith("event:") -> eventName = line.substringAfter(':').trim()
                    line.startsWith("data:") -> data.append(line.substringAfter(':').trim())
                    line.isEmpty() -> {
                        if (data.isNotEmpty()) when (eventName) {
                            "snapshot" -> {
                                val snapshot = json.decodeFromString<BridgeSnapshot>(data.toString())
                                latest = snapshot
                                onSnapshot(snapshot)
                            }
                            // A patch only makes sense against the snapshot it was computed from;
                            // without one the connection is not yet synced, so wait for the full send.
                            "patch" -> latest?.let { previous ->
                                val merged = previous.applyPatch(json.decodeFromString<BridgeSnapshotPatch>(data.toString()))
                                latest = merged
                                onSnapshot(merged)
                            }
                        }
                        eventName = ""
                        data.clear()
                    }
                }
            }
        }
        activeStreamCall = null
    }

    fun cancelStream() {
        activeStreamCall?.cancel()
        activeStreamCall = null
    }

    suspend fun analytics(range: String, project: String? = null): AnalyticsSnapshot = withContext(Dispatchers.IO) {
        val url = "$baseUrl/bridge/v1/analytics".toHttpUrl().newBuilder()
            .addQueryParameter("range", range)
            .addQueryParameter("timeZone", TimeZone.getDefault().id)
            .apply { project?.let { addQueryParameter("project", it) } }
            .build()
        val request = requestBuilder(url.toString()).get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Analytics returned ${response.code}")
            json.decodeFromString<AnalyticsSnapshot>(response.body.string())
        }
    }

    suspend fun pair(code: String, deviceName: String): PairedDevice = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PairRequest(code, deviceName))
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url("$baseUrl/bridge/v1/pair").post(body).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val message = runCatching { response.body.string() }.getOrDefault("")
                error(if (response.code == 401) "Pairing code is invalid or expired" else "Pairing failed (${response.code}): $message")
            }
            json.decodeFromString<PairedDevice>(response.body.string())
        }
    }

    suspend fun control(agentId: String, action: String, value: String? = null, commandId: String? = null) = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ControlRequest(action, value, commandId))
            .toRequestBody("application/json".toMediaType())
        val request = requestBuilder("$baseUrl/bridge/v1/agents/$agentId/control").post(body).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Command failed (${response.code})")
        }
    }

    suspend fun answerQuestion(agentId: String, requestId: String, question: String, answer: String) = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ManagedResolutionRequest("answered", mapOf(question to answer)))
            .toRequestBody("application/json".toMediaType())
        // Generic route: bridge-hosted sessions are answered in process, hook sessions durably.
        val request = requestBuilder("$baseUrl/bridge/v1/agents/$agentId/requests/$requestId/resolve").post(body).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Answer failed (${response.code})")
        }
    }

    suspend fun commandReceipt(commandId: String): CommandReceipt = withContext(Dispatchers.IO) {
        val request = requestBuilder("$baseUrl/bridge/v1/commands/$commandId/receipt").build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Receipt unavailable (${response.code})")
            json.decodeFromString<CommandReceipt>(response.body.string())
        }
    }

    private fun requestBuilder(url: String): Request.Builder = Request.Builder().url(url).apply {
        if (token.isNotBlank()) header("Authorization", "Bearer $token")
    }

    private fun normalizeUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        return when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            else -> "http://$trimmed"
        }
    }
}

class AgentRepository(private val client: BridgeClient) {
    private val _state = MutableStateFlow<BridgeState>(BridgeState.Loading)
    private var lastSequence = -1L
    private val wakeups = Channel<Unit>(Channel.CONFLATED)
    private val _connection = MutableStateFlow(ConnectionStatus("connecting"))
    val state: StateFlow<BridgeState> = _state.asStateFlow()
    val connection: StateFlow<ConnectionStatus> = _connection.asStateFlow()

    suspend fun stream(reconnectDelayMs: Long = 1_500) {
        var retryDelay = reconnectDelayMs
        var attempt = 0
        while (kotlin.coroutines.coroutineContext.isActive) {
            attempt += 1
            _connection.value = ConnectionStatus(if (lastSequence < 0) "connecting" else "reconnecting", attempt)
            val previous = currentSnapshot()
            var synchronized = false
            runCatching {
                client.streamSnapshots { snapshot ->
                    if (ConnectionPolicy.shouldApply(lastSequence, snapshot.sequence)) {
                        lastSequence = snapshot.sequence
                        synchronized = true
                        retryDelay = reconnectDelayMs
                        _connection.value = ConnectionStatus("connected", attempt)
                        _state.value = BridgeState.Ready(snapshot)
                    }
                }
            }.onFailure {
                val message = it.message ?: "Live connection lost"
                _state.value = BridgeState.Failed(message, previous)
                _connection.value = ConnectionStatus(if (ConnectionPolicy.isBlocked(message)) "blocked" else "backoff", attempt, if (ConnectionPolicy.isBlocked(message)) null else System.currentTimeMillis() + retryDelay, message)
            }
            if (_connection.value.phase == "blocked") wakeups.receive()
            else withTimeoutOrNull(retryDelay) { wakeups.receive() }
            if (!synchronized) retryDelay = ConnectionPolicy.retryDelay(reconnectDelayMs, attempt + 1) else attempt = 0
        }
    }

    private fun currentSnapshot() = when (val current = _state.value) {
        is BridgeState.Ready -> current.snapshot
        is BridgeState.Failed -> current.previous
        BridgeState.Loading -> null
    }

    suspend fun refresh() {
        val previous = currentSnapshot()
        runCatching { client.snapshot() }
            .onSuccess {
                if (ConnectionPolicy.shouldApply(lastSequence, it.sequence)) {
                    lastSequence = it.sequence
                    _state.value = BridgeState.Ready(it)
                }
            }
            .onFailure { _state.value = BridgeState.Failed(it.message ?: "Bridge unavailable", previous) }
    }

    suspend fun control(agentId: String, action: String, value: String? = null, commandId: String? = null) {
        client.control(agentId, action, value, commandId)
        refresh()
    }

    suspend fun changes(agentId: String): List<AgentEvent> = client.changes(agentId)

    suspend fun history(agentId: String): List<AgentEvent> = client.history(agentId)

    suspend fun slashCommands(agentId: String): List<SlashCommand> = client.slashCommands(agentId)

    suspend fun answerQuestion(agentId: String, requestId: String, question: String, answer: String) {
        client.answerQuestion(agentId, requestId, question, answer)
        refresh()
    }

    fun wake() {
        client.cancelStream()
        wakeups.trySend(Unit)
    }

    fun configure(url: String, token: String) {
        client.configure(url, token)
        wake()
    }
}

