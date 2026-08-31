import Foundation

/// The wire contract, mirrored from `apps/android/shared/.../BridgeModels.kt`.
///
/// Every optional here is optional on the wire too: the adapters are separate
/// programs and the bridge accepts a field absent or null. Decoding is
/// deliberately forgiving about what it does not know — an unknown key is not
/// an error, because a bridge is allowed to grow one before this app does.
/// Absent is not the same as wrong.
///
/// Swift's synthesized `init(from:)` does not fall back to a property's default
/// value when a key is missing — it throws. The bridge legitimately omits
/// `options`, `capabilities`, `events` and more, so every optional-on-the-wire
/// field is read through this rather than declared and hoped for.
private extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, or fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    func optional<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

struct BridgeSnapshot: Decodable, Equatable {
    var sequence: Int64
    var bridge: BridgeInfo
    var summary: Summary
    var agents: [Agent]

    init(sequence: Int64, bridge: BridgeInfo, summary: Summary, agents: [Agent]) {
        self.sequence = sequence
        self.bridge = bridge
        self.summary = summary
        self.agents = agents
    }

    private enum CodingKeys: String, CodingKey { case sequence, bridge, summary, agents }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sequence = container.value(.sequence, or: 0)
        bridge = try container.decode(BridgeInfo.self, forKey: .bridge)
        summary = container.value(.summary, or: Summary())
        agents = container.value(.agents, or: [])
    }
}

struct BridgeInfo: Decodable, Equatable {
    var status: String
    var name: String
    var timestamp: String

    private enum CodingKeys: String, CodingKey { case status, name, timestamp }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = container.value(.status, or: "unknown")
        name = container.value(.name, or: "Bridge")
        timestamp = container.value(.timestamp, or: "")
    }
}

struct Summary: Decodable, Equatable {
    var active = 0
    var waiting = 0
    var errors = 0
    var tokens: Int64 = 0
    var costUsd: Double = 0

    init() {}

    private enum CodingKeys: String, CodingKey { case active, waiting, errors, tokens, costUsd }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        active = container.value(.active, or: 0)
        waiting = container.value(.waiting, or: 0)
        errors = container.value(.errors, or: 0)
        tokens = container.value(.tokens, or: 0)
        costUsd = container.value(.costUsd, or: 0)
    }
}

struct Agent: Decodable, Equatable, Identifiable {
    var id: String
    var name: String
    var project: String
    var model: String
    var state: String
    var task: String
    /// The directory the session works in, on the bridge's machine — what lets
    /// this app offer "start another one here". Older bridges omit it.
    var cwd: String?
    var objective: String?
    var progress: Double?
    var tokens: Int64
    var processedTokens: Int64?
    var costUsd: Double
    var lastSeenAt: String
    /// The last moment a person looked at this session on any surface — the
    /// bridge's word, not this phone's. `SeenPolicy` merges it with the local
    /// marks so a session read on the watch stops badging here too.
    var viewedAt: String?
    /// The adapter's own word for its runtime — "claude", "codex", "opencode", "pi".
    var runtime: String?
    var events: [AgentEvent]
    /// An absent list is not an empty one: nil means the runtime advertised
    /// nothing, which `supportsCapability` answers false for either way, but
    /// the distinction is the wire's and is kept.
    var capabilities: [String]?
    var rateLimits: [RateLimitWindow]
    var pendingApproval: PendingApproval?
    var pendingQuestion: PendingQuestion?

    private enum CodingKeys: String, CodingKey {
        case id, name, project, model, state, task, cwd, objective, progress
        case tokens, processedTokens, costUsd, lastSeenAt, viewedAt, runtime, events
        case capabilities, rateLimits, pendingApproval, pendingQuestion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = container.value(.name, or: "")
        project = container.value(.project, or: "")
        model = container.value(.model, or: "")
        state = container.value(.state, or: "idle")
        task = container.value(.task, or: "")
        cwd = container.optional(.cwd)
        objective = container.optional(.objective)
        progress = container.optional(.progress)
        tokens = container.value(.tokens, or: 0)
        processedTokens = container.optional(.processedTokens)
        costUsd = container.value(.costUsd, or: 0)
        lastSeenAt = container.value(.lastSeenAt, or: "")
        viewedAt = container.optional(.viewedAt)
        runtime = container.optional(.runtime)
        events = container.value(.events, or: [])
        capabilities = container.optional(.capabilities)
        rateLimits = container.value(.rateLimits, or: [])
        pendingApproval = container.optional(.pendingApproval)
        pendingQuestion = container.optional(.pendingQuestion)
    }
}

struct AgentEvent: Decodable, Equatable, Identifiable {
    var id: String
    var kind: String
    var summary: String
    var detail: String?
    var createdAt: String
    var tool: String?
    var path: String?
    var command: String?
    var diff: String?
    var options: [String]
    /// Which subagent produced this, where a subagent did.
    ///
    /// Claude Code tags every tool hook made inside a subagent with its own id
    /// and type. A session running three of them reported their tool calls
    /// mixed into its own, so "what is it doing" had no answer smaller than
    /// all of it.
    var subagentId: String?
    var subagentType: String?
    /// What the run was asked to do — the Task call's own wording.
    var subagentName: String?
    /// The exchange this event belongs to — one instruction and everything
    /// done in its service. The deck's thread unit; older bridges omit it.
    var turnId: String?

    private enum CodingKeys: String, CodingKey {
        case id, kind, summary, detail, createdAt, tool, path, command, diff, options
        case subagentId, subagentType, subagentName, turnId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = container.value(.kind, or: "")
        summary = container.value(.summary, or: "")
        detail = container.optional(.detail)
        createdAt = container.value(.createdAt, or: "")
        tool = container.optional(.tool)
        path = container.optional(.path)
        command = container.optional(.command)
        diff = container.optional(.diff)
        options = container.value(.options, or: [])
        subagentId = container.optional(.subagentId)
        subagentType = container.optional(.subagentType)
        subagentName = container.optional(.subagentName)
        turnId = container.optional(.turnId)
    }
}

struct PendingApproval: Decodable, Equatable {
    var id: String
    var tool: String
    var detail: String
    var createdAt: String
    var expiresAt: String

    private enum CodingKeys: String, CodingKey { case id, tool, detail, createdAt, expiresAt }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        tool = container.value(.tool, or: "")
        detail = container.value(.detail, or: "")
        createdAt = container.value(.createdAt, or: "")
        expiresAt = container.value(.expiresAt, or: "")
    }
}

struct PendingQuestion: Decodable, Equatable {
    var id: String
    var question: String
    var options: [String]
    var createdAt: String
    var expiresAt: String

    init(id: String, question: String, options: [String], createdAt: String, expiresAt: String) {
        self.id = id
        self.question = question
        self.options = options
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey { case id, question, options, createdAt, expiresAt }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        question = container.value(.question, or: "")
        options = container.value(.options, or: [])
        createdAt = container.value(.createdAt, or: "")
        expiresAt = container.value(.expiresAt, or: "")
    }
}

struct RateLimitWindow: Decodable, Equatable, Identifiable {
    var id: String
    var label: String
    var usedPercent: Double
    var resetsAt: String?
    var account: String?
    var runtime: String?

    private enum CodingKeys: String, CodingKey { case id, label, usedPercent, resetsAt, account, runtime }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = container.value(.label, or: "")
        usedPercent = container.value(.usedPercent, or: 0)
        resetsAt = container.optional(.resetsAt)
        account = container.optional(.account)
        runtime = container.optional(.runtime)
    }
}

/// An incremental stream update: the agents whose rendered state changed, plus
/// any that are gone. Everything absent from it is unchanged and must be
/// carried over from the previous snapshot.
struct BridgeSnapshotPatch: Decodable {
    var sequence: Int64
    var bridge: BridgeInfo
    var summary: Summary
    var agents: [Agent]
    var removed: [String]

    private enum CodingKeys: String, CodingKey { case sequence, bridge, summary, agents, removed }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sequence = container.value(.sequence, or: 0)
        bridge = try container.decode(BridgeInfo.self, forKey: .bridge)
        summary = container.value(.summary, or: Summary())
        agents = container.value(.agents, or: [])
        removed = container.value(.removed, or: [])
    }
}

extension BridgeSnapshot {
    /// Applies a patch to the snapshot it was computed against, preserving
    /// agent order where possible.
    func applying(_ patch: BridgeSnapshotPatch) -> BridgeSnapshot {
        let changed = Dictionary(patch.agents.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let removed = Set(patch.removed)
        let kept = agents.filter { !removed.contains($0.id) }.map { changed[$0.id] ?? $0 }
        let known = Set(agents.map(\.id))
        let added = patch.agents.filter { !known.contains($0.id) }
        return BridgeSnapshot(
            sequence: patch.sequence,
            bridge: patch.bridge,
            summary: patch.summary,
            agents: kept + added
        )
    }
}

struct AgentHistory: Decodable {
    var events: [AgentEvent]

    private enum CodingKeys: String, CodingKey { case events }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        events = ((try? container.decodeIfPresent([AgentEvent].self, forKey: .events)) ?? nil) ?? []
    }
}

struct AgentChanges: Decodable {
    var changes: [AgentEvent]

    private enum CodingKeys: String, CodingKey { case changes }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        changes = ((try? container.decodeIfPresent([AgentEvent].self, forKey: .changes)) ?? nil) ?? []
    }
}

struct PairRequest: Encodable {
    var code: String
    var deviceName: String
}

struct PairedDevice: Decodable {
    var id: String
    var token: String
    var name: String
    var createdAt: String
}

struct ControlRequest: Encodable {
    var action: String
    var value: String?
    var commandId: String?
    /// Deliver even to a session blocked on an approval or question. Nil — the
    /// ordinary case — is omitted from the wire entirely.
    var force: Bool?
}

/// `POST /agents/:id/requests/:requestId/resolve`. A device may only ever send
/// `answered`; every other status is the runtime credential's to record, and
/// the bridge answers 403 if a device tries.
struct ResolveRequest: Encodable {
    var status: String = "answered"
    var value: [String: String]
}

/// One runtime the bridge can host and run itself, rather than only observe.
struct ManagedRuntime: Decodable, Equatable {
    var runtime: String
    var capabilities: [String]
    var managed: Bool

    private enum CodingKeys: String, CodingKey { case runtime, capabilities, managed }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runtime = container.value(.runtime, or: "")
        capabilities = container.value(.capabilities, or: [])
        managed = container.value(.managed, or: true)
    }
}

struct ManagedRuntimes: Decodable {
    var runtimes: [ManagedRuntime] = []

    private enum CodingKeys: String, CodingKey { case runtimes }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runtimes = container.value(.runtimes, or: [])
    }
}

/// Body for starting a bridge-hosted session. The `cwd` must be absolute and
/// exist on the bridge's machine.
struct ManagedSessionRequest: Encodable {
    var project: String
    var cwd: String
    var model: String?
    var objective: String?
    var prompt: String?
    var permissionMode: String?
}

/// What a caller gets back once a hosted session is running.
struct StartedManagedSession: Decodable, Equatable {
    var agentId: String
    var providerSessionId: String?
    var project: String
    var model: String
    var permissionMode: String

    private enum CodingKeys: String, CodingKey { case agentId, providerSessionId, project, model, permissionMode }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try container.decode(String.self, forKey: .agentId)
        providerSessionId = container.optional(.providerSessionId)
        project = container.value(.project, or: "")
        model = container.value(.model, or: "")
        permissionMode = container.value(.permissionMode, or: "default")
    }
}

/// Whether a runtime advertises an action. An absent list advertises nothing.
func supportsCapability(_ capabilities: [String]?, _ action: String) -> Bool {
    capabilities?.contains(action) == true
}

/// Order-preserving unique, for the project names already on the deck offered
/// as quick fills: the first time a project appears is the order a person sees.
extension Sequence where Element: Hashable {
    var deduplicated: [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

/// One instruction still waiting for its runtime — listed so it can be taken back.
struct QueuedCommand: Decodable, Identifiable, Equatable {
    var id: String
    var agentId: String
    var action: String
    var value: String?
    var createdAt: String
}

struct QueuedCommands: Decodable {
    var commands: [QueuedCommand]
}
