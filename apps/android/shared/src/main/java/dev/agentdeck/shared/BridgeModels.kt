package dev.agentdeck.shared

import kotlinx.serialization.Serializable

@Serializable
data class AgentChanges(val changes: List<AgentEvent> = emptyList())

@Serializable
data class AgentHistory(val events: List<AgentEvent> = emptyList())

/**
 * An incremental stream update: the agents whose rendered state changed, plus any that are gone.
 * Everything absent from it is unchanged and must be carried over from the previous snapshot.
 */
@Serializable
data class BridgeSnapshotPatch(
    val sequence: Long = 0,
    val bridge: BridgeInfo,
    val summary: Summary,
    val agents: List<Agent> = emptyList(),
    val removed: List<String> = emptyList(),
)

/** Applies a patch to the snapshot it was computed against, preserving agent order where possible. */
fun BridgeSnapshot.applyPatch(patch: BridgeSnapshotPatch): BridgeSnapshot {
    val changed = patch.agents.associateBy { it.id }
    val kept = agents.filterNot { it.id in patch.removed }.map { changed[it.id] ?: it }
    val added = patch.agents.filter { incoming -> agents.none { it.id == incoming.id } }
    return BridgeSnapshot(patch.sequence, patch.bridge, patch.summary, kept + added)
}

@Serializable
data class SlashCommand(val name: String, val description: String? = null, val source: String = "user")

@Serializable
data class SlashCommandCatalog(val commands: List<SlashCommand> = emptyList())

@Serializable
data class BridgeSnapshot(
    val sequence: Long = 0,
    val bridge: BridgeInfo,
    val summary: Summary,
    val agents: List<Agent>,
)

@Serializable
data class BridgeInfo(val status: String, val name: String, val timestamp: String)

@Serializable
data class Summary(
    val active: Int,
    val waiting: Int,
    val errors: Int,
    val tokens: Long,
    val costUsd: Double,
)

@Serializable
data class Agent(
    val id: String,
    val name: String,
    val project: String,
    /** The directory the session works in, on the bridge's machine. */
    val cwd: String? = null,
    val model: String,
    val state: String,
    val task: String,
    val objective: String? = null,
    val progress: Double? = null,
    val tokens: Long,
    val processedTokens: Long? = null,
    val costUsd: Double,
    val lastSeenAt: String,
    /** The last moment a person looked at this session on any surface, by the bridge's account. */
    val viewedAt: String? = null,
    /** The adapter's own word for its runtime — "claude", "codex", "opencode", "pi". */
    val runtime: String? = null,
    val events: List<AgentEvent> = emptyList(),
    val capabilities: List<String>? = null,
    val rateLimits: List<RateLimitWindow> = emptyList(),
    val pendingApproval: PendingApproval? = null,
    val pendingQuestion: PendingQuestion? = null,
)

@Serializable
data class AgentEvent(
    val id: String,
    val kind: String,
    val summary: String,
    val detail: String? = null,
    val createdAt: String,
    val tool: String? = null,
    val path: String? = null,
    val command: String? = null,
    val diff: String? = null,
    val options: List<String> = emptyList(),
    /**
     * Which subagent produced this, where a subagent did.
     *
     * Absent on the parent's own work, which is the whole distinction: a
     * session running three subagents used to report their tool calls mixed
     * into its own with nothing to tell them apart.
     */
    val subagentId: String? = null,
    val subagentType: String? = null,
    /** What the run was asked to do - the Task call's own wording. */
    val subagentName: String? = null,
    /** Which exchange this belongs to - the deck's thread unit. */
    val turnId: String? = null,
)

@Serializable
data class PendingApproval(val id: String, val tool: String, val detail: String, val createdAt: String, val expiresAt: String)

@Serializable
data class PendingQuestion(
    val id: String,
    val question: String,
    val options: List<String> = emptyList(),
    val createdAt: String,
    val expiresAt: String,
)

@Serializable
data class RateLimitWindow(val id: String, val label: String, val usedPercent: Double, val resetsAt: String? = null, val account: String? = null, val runtime: String? = null)

@Serializable
data class AnalyticsSnapshot(
    val range: String,
    val project: String? = null,
    val timeZone: String = "UTC",
    val generatedAt: String,
    val summary: AnalyticsSummary,
    val series: List<AnalyticsPoint>,
    val heatmap: List<ActivityDay>,
    val projects: List<ProjectUsage>,
    val runtimes: List<RuntimeUsage>,
    val limits: List<RateLimitWindow> = emptyList(),
    val filters: AnalyticsFilters,
)

@Serializable
data class TokenFacets(val uncachedInput: Long = 0, val cachedInput: Long = 0, val cacheCreation: Long = 0, val output: Long = 0, val reasoning: Long = 0)

@Serializable
data class AnalyticsSummary(val tokens: Long, val costUsd: Double, val events: Int, val sessions: Int, val activeDays: Int, val unpricedTokens: Long = 0, val costCoveragePercent: Double = 100.0, val tokenFacets: TokenFacets = TokenFacets())

@Serializable
data class AnalyticsPoint(val bucket: String, val tokens: Long, val costUsd: Double, val events: Int)

@Serializable
data class ActivityDay(val date: String, val count: Int, val tokens: Long, val costUsd: Double)

@Serializable
data class ProjectUsage(val project: String, val tokens: Long, val costUsd: Double, val events: Int, val sessions: Int)

@Serializable
data class RuntimeUsage(val runtime: String, val tokens: Long, val costUsd: Double, val events: Int)

@Serializable
data class AnalyticsFilters(val projects: List<String>)

sealed interface AnalyticsState {
    data object Loading : AnalyticsState
    data class Ready(val data: AnalyticsSnapshot) : AnalyticsState
    data class Failed(val message: String, val previous: AnalyticsSnapshot? = null) : AnalyticsState
}

@Serializable
data class ControlRequest(
    val action: String,
    val value: String? = null,
    val commandId: String? = null,
    /** Overrides the bridge's refusal to message a session blocked on an approval or question. */
    val force: Boolean? = null,
)

/** The body of a bridge refusal, such as the 409 for messaging a blocked session. */
@Serializable
data class ControlRefusal(val error: String? = null, val detail: String? = null)

@Serializable
data class ManagedResolutionRequest(val status: String, val value: Map<String, String>)

@Serializable
data class CommandReceipt(val commandId: String, val status: String, val error: String? = null, val resultSequence: Long? = null, val updatedAt: String)

@Serializable
data class PairRequest(val code: String, val deviceName: String)

@Serializable
data class PairedDevice(val id: String, val token: String, val name: String, val createdAt: String)

data class ConnectionStatus(val phase: String, val attempt: Int = 0, val retryAt: Long? = null, val error: String? = null)

sealed interface BridgeState {
    data object Loading : BridgeState
    data class Ready(val snapshot: BridgeSnapshot, val refreshedAt: Long = System.currentTimeMillis()) : BridgeState
    data class Failed(val message: String, val previous: BridgeSnapshot? = null) : BridgeState
}

/** One runtime the bridge can host and run itself, rather than only observe. */
@Serializable
data class ManagedRuntime(
    val runtime: String,
    val capabilities: List<String> = emptyList(),
    val managed: Boolean = true,
)

@Serializable
data class ManagedRuntimes(val runtimes: List<ManagedRuntime> = emptyList())

/**
 * Body for starting a bridge-hosted session. The `cwd` must be absolute and
 * exist on the bridge's machine, so a surface offers only paths it already saw
 * a session run in - the ones the bridge has proven it can reach.
 */
@Serializable
data class ManagedSessionRequest(
    val project: String,
    val cwd: String,
    val model: String? = null,
    val objective: String? = null,
    val prompt: String? = null,
    val permissionMode: String? = null,
)

/** What a caller gets back once a hosted session is running. */
@Serializable
data class StartedManagedSession(
    val agentId: String,
    val providerSessionId: String? = null,
    val project: String,
    val model: String,
    val permissionMode: String,
)
