package dev.agentdeck.shared

import kotlinx.serialization.Serializable

@Serializable
data class AgentChanges(val changes: List<AgentEvent> = emptyList())

@Serializable
data class AgentHistory(val events: List<AgentEvent> = emptyList())

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
    val model: String,
    val state: String,
    val task: String,
    val objective: String? = null,
    val progress: Double? = null,
    val tokens: Long,
    val processedTokens: Long? = null,
    val costUsd: Double,
    val lastSeenAt: String,
    val events: List<AgentEvent> = emptyList(),
    val capabilities: List<String>? = null,
    val rateLimits: List<RateLimitWindow> = emptyList(),
    val pendingApproval: PendingApproval? = null,
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
)

@Serializable
data class PendingApproval(val id: String, val tool: String, val detail: String, val createdAt: String, val expiresAt: String)

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
data class ControlRequest(val action: String, val value: String? = null, val commandId: String? = null)

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
