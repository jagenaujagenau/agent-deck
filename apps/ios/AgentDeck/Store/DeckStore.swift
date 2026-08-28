import Foundation
import Observation
import UIKit

/// The one place the deck's state is decided.
///
/// **SSE, not polling.** The bridge diffs per connection and sends only the
/// agents whose rendered state actually changed, so the live path costs a
/// fraction of a repeated `/snapshot` and shows an approval the moment it
/// opens rather than up to a poll interval later — which is the whole point of
/// a surface you glance at. `URLSession.bytes(for:)` streams the body
/// incrementally, so no third-party client is needed. `/snapshot` is still
/// used, for the first paint and for pull-to-refresh, because a full read is
/// the cheapest way to recover from a patch we could not apply.
/// What someone typed into the credential field.
enum Credential {
    case none
    /// Six digits, issued by the bridge at startup and good for ten minutes.
    case pairingCode
    /// The bridge's own `BRIDGE_TOKEN`, which never expires and needs no
    /// pairing round trip.
    case rawToken

    static func of(_ value: String) -> Credential {
        if value.isEmpty { return .none }
        if value.count == 6, value.allSatisfy(\.isNumber) { return .pairingCode }
        return .rawToken
    }
}

@MainActor
@Observable
final class DeckStore {
    private(set) var snapshot: BridgeSnapshot?
    private(set) var phase: ConnectionPhase = .connecting
    private(set) var failure: BridgeError?
    /// Kept so the deck can go on showing the last good state under an error
    /// banner. A blank screen is a worse answer than a stale one clearly marked.
    private(set) var lastUpdate: Date?

    var connection: Connection
    var filter: HomeFilter = .now

    /// Sessions the person has put away. A device decision — the runtime is
    /// still running and the bridge is never told.
    private(set) var archived: Set<String> = ArchivePolicy.load()

    /// When each session was last looked at, and which one is on screen now.
    /// Only an open session view moves a mark — the deck listing a card is not
    /// reading it, and a machine refresh is nobody reading anything.
    private(set) var seenMarks: [String: String] = SeenPolicy.load()
    private var viewedSession: String?

    /// Completion debouncing: the last state each session was observed in, and
    /// the clock running on any that just went running→idle.
    private var observedStates: [String: String] = [:]
    private var pendingCompletions: [String: Task<Void, Never>] = [:]

    /// Per-session caches, keyed by agent id. Held here rather than in the
    /// session view so switching sessions and coming back does not refetch a
    /// history the app already has.
    private(set) var sessionChanges: [String: [AgentEvent]] = [:]
    private(set) var slashCommands: [String: [SlashCommand]] = [:]

    private(set) var analytics: AnalyticsState = .loading
    private var analyticsTask: Task<Void, Never>?

    private let client = BridgeClient()
    private var lastSequence: Int64 = -1
    private var streamTask: Task<Void, Never>?
    private var isStreamFinished = true

    init(connection: Connection = ConnectionStore.load()) {
        self.connection = connection
    }

    var isConnected: Bool { connection.isConfigured }

    /// Everything the bridge reports, archived sessions included. The deck is
    /// built from `agents`; this is what the archive itself is drawn from.
    var allAgents: [Agent] { snapshot?.agents ?? [] }

    var agents: [Agent] { ArchivePolicy.unarchived(allAgents, archived: archived) }

    /// Archived sessions are not hidden, they are filed: History is where a
    /// person goes to find one again, and it reads every session the bridge
    /// reports rather than only the unarchived ones.
    func groups(now: Date = Date()) -> [DeckGroup] {
        deckGroups(allAgents, filter: filter, archived: archived, seen: { self.isSeen($0) }, now: now)
    }

    // MARK: - Seen

    func isSeen(_ agent: Agent) -> Bool { SeenPolicy.isSeen(agent, marks: seenMarks) }

    /// The session view is open on this session. Opening it is the one act
    /// that counts as seeing, so the mark moves now and keeps moving on every
    /// snapshot for as long as the view stays up.
    func beginViewing(agentId: String) {
        viewedSession = agentId
        markSeen(agentId)
    }

    func endViewing(agentId: String) {
        if viewedSession == agentId { viewedSession = nil }
    }

    private func markSeen(_ agentId: String) {
        guard let agent = allAgents.first(where: { $0.id == agentId }) else { return }
        let at = SeenPolicy.activityAt(agent)
        guard (seenMarks[agentId] ?? "") < at else { return }
        seenMarks[agentId] = at
        SeenPolicy.save(seenMarks)
        // The other surfaces should stop badging too. Fire-and-forget: the
        // local mark above already cleared this phone's badge, and a bridge
        // that cannot be reached right now changes nothing about that.
        Task { [client] in try? await client.markSeen(agentId: agentId) }
        // A "finished" banner about a session being read right now is stale.
        ApprovalNotifier.shared.withdrawCompletion(agentId: agentId)
    }

    // MARK: - Archive

    func isArchived(_ agent: Agent) -> Bool { archived.contains(ArchivePolicy.archiveKey(agent)) }

    func archive(_ agent: Agent) {
        archived.insert(ArchivePolicy.archiveKey(agent))
        ArchivePolicy.save(archived)
        // An archived session is not asking for anything any more, so whatever
        // it posted goes with it.
        ApprovalNotifier.shared.withdraw(agentId: agent.id)
    }

    func restore(_ agent: Agent) {
        archived.remove(ArchivePolicy.archiveKey(agent))
        ArchivePolicy.save(archived)
    }

    /// Dismisses a session from the bridge's deck. Optimistic: the card leaves
    /// now and the SSE patch confirms; a refusal puts it quietly back, because
    /// the bridge still lists it and the next snapshot would anyway.
    func dismiss(agentId: String) {
        guard let index = snapshot?.agents.firstIndex(where: { $0.id == agentId }) else { return }
        let removed = snapshot?.agents.remove(at: index)
        // A dismissed session is not asking for anything any more.
        ApprovalNotifier.shared.withdraw(agentId: agentId)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.client.dismiss(agentId: agentId)
            } catch {
                // 404 means the bridge already forgot it, which is the outcome
                // that was asked for.
                if case BridgeError.http(404, _) = error { return }
                guard let removed, self.snapshot?.agents.contains(where: { $0.id == agentId }) == false else { return }
                self.snapshot?.agents.append(removed)
            }
        }
    }

    /// How many sessions want a person right now, for the header count.
    func attentionCount(now: Date = Date()) -> Int {
        agents.filter { homeAgentState($0, now: now).attention }.count
    }

    func agent(id: String) -> Agent? { agents.first { $0.id == id } }

    // MARK: - Connecting

    /// Pairs if a code was given, otherwise reuses whatever token this address
    /// already has. A bridge with `requireAuth` off accepts an empty one, so an
    /// absent code is a legitimate answer and not an error.
    func connect(baseURL: String, pairingCode: String, deviceName: String) async throws {
        let normalized = BridgeClient.normalize(baseURL)
        guard !normalized.isEmpty else { throw BridgeError.unreachable("Enter the bridge's address.") }

        var token = ConnectionStore.token(for: normalized)
        let credential = pairingCode.trimmed
        // Six digits is a pairing code; anything else in that field is the
        // bridge's own token, pasted directly. The connect screen has always
        // said so — this used to send a token to /pair, which answered "that
        // pairing code is invalid or expired" about something that was never a
        // pairing code.
        switch Credential.of(credential) {
        case .none:
            break
        case .pairingCode:
            await client.configure(baseURL: normalized, token: "")
            let device = try await client.pair(
                code: credential,
                deviceName: deviceName.trimmed.isEmpty ? Connection.defaultDeviceName : deviceName.trimmed
            )
            token = device.token
        case .rawToken:
            token = credential
        }

        await client.configure(baseURL: normalized, token: token)
        // Prove the credential before storing it: a token saved and then
        // refused on the deck screen is a failure reported in the wrong place.
        let first = try await client.snapshot()

        ConnectionStore.store(token: token, for: normalized)
        connection.baseURL = normalized
        connection.deviceName = deviceName.trimmed.isEmpty ? Connection.defaultDeviceName : deviceName.trimmed
        ConnectionStore.save(connection)

        stop()
        lastSequence = first.sequence
        snapshot = first
        lastUpdate = Date()
        failure = nil
        phase = .connected
        start()
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        ConnectionStore.forget(connection.baseURL)
        connection.baseURL = ""
        snapshot = nil
        lastSequence = -1
        failure = nil
        phase = .connecting
    }

    // MARK: - Live

    func start() {
        guard connection.isConfigured else { return }
        // A finished task is not a running one. Checking for nil alone meant a
        // stream that had returned — blocked on a refused credential, or
        // cancelled on backgrounding — could never be replaced, and the deck
        // stayed dead until the app was killed.
        if let streamTask, !streamTask.isCancelled, !isStreamFinished { return }
        streamTask?.cancel()
        let url = connection.baseURL
        let token = ConnectionStore.token(for: url)
        isStreamFinished = false
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.client.configure(baseURL: url, token: token)
            await self.runStream()
            await MainActor.run { self.isStreamFinished = true }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        isStreamFinished = true
    }

    private func runStream() async {
        var attempt = 0
        while !Task.isCancelled {
            attempt += 1
            phase = lastSequence < 0 ? .connecting : .reconnecting(attempt: attempt)
            var synchronized = false
            do {
                try await client.streamSnapshots { [weak self] snapshot in
                    Task { @MainActor [weak self] in self?.apply(snapshot) }
                }
                // The stream ended without an error: the bridge closed it, or
                // the app was backgrounded. Treated as a reconnect, not a fault.
                synchronized = lastSequence >= 0
            } catch is CancellationError {
                return
            } catch {
                // URLSession reports a cancelled stream as URLError.cancelled,
                // not CancellationError, so backgrounding the app used to raise
                // a "connection lost" banner on the way out.
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                let bridgeError = BridgeError.from(error)
                failure = bridgeError
                if bridgeError == .unauthorized {
                    // Nothing about waiting fixes a refused credential, so the
                    // loop stops until the user changes something.
                    phase = .blocked(bridgeError.localizedDescription)
                    return
                }
                phase = .backoff(bridgeError.localizedDescription)
            }
            if Task.isCancelled { return }
            if synchronized { attempt = 0 }
            let delay = ConnectionPolicy.retryDelay(base: .milliseconds(1_500), failedAttempts: attempt)
            try? await Task.sleep(for: delay)
        }
    }

    private func apply(_ incoming: BridgeSnapshot) {
        guard ConnectionPolicy.shouldApply(lastSequence: lastSequence, incoming: incoming.sequence) else { return }
        lastSequence = incoming.sequence
        snapshot = incoming
        lastUpdate = Date()
        failure = nil
        phase = .connected
        // Every snapshot is reconciled, not just the ones that arrive while a
        // screen is open: the notification is the whole point of the stream
        // when nobody is looking at the deck.
        ApprovalNotifier.shared.reconcile(agents: agents)
        // An open session view keeps its seen mark current — but only while the
        // app is actually in front. A snapshot landing on a backgrounded view
        // is a machine refresh, and machine refreshes never mark seen.
        if let viewedSession, UIApplication.shared.applicationState == .active {
            markSeen(viewedSession)
        }
        trackCompletions(agents)
    }

    /// The "finished" side of notifications. `AttentionPolicy` announces a
    /// session going blocked the instant it happens; a completion is only
    /// announced once `CompletionPolicy`'s window has proven that running→idle
    /// was a finish and not a flicker between tool calls.
    private func trackCompletions(_ current: [Agent]) {
        for agent in current {
            let step = CompletionPolicy.step(previous: observedStates[agent.id], current: agent.state)
            observedStates[agent.id] = agent.state
            switch step {
            case .hold:
                break
            case .disarm:
                // Back to work (or blocked, or gone wrong) within the window:
                // the pending announcement was about to be a lie.
                pendingCompletions.removeValue(forKey: agent.id)?.cancel()
            case .arm:
                pendingCompletions[agent.id]?.cancel()
                pendingCompletions[agent.id] = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(CompletionPolicy.debounce))
                    guard !Task.isCancelled, let self else { return }
                    self.pendingCompletions[agent.id] = nil
                    // Decided against the state *now*, not the one that armed
                    // the clock: the whole point of waiting is that it may
                    // have changed.
                    guard let live = self.agent(id: agent.id) else { return }
                    let viewing = self.viewedSession == live.id
                        && UIApplication.shared.applicationState == .active
                    guard CompletionPolicy.shouldAnnounce(
                        state: live.state,
                        seen: self.isSeen(live),
                        viewingInForeground: viewing
                    ) else { return }
                    ApprovalNotifier.shared.postCompletion(agent: live)
                }
            }
        }
    }

    /// Pull to refresh, and the recovery path after a patch we could not apply.
    func refresh() async {
        guard connection.isConfigured else { return }
        do {
            let fresh = try await client.snapshot()
            apply(fresh)
        } catch {
            failure = BridgeError.from(error)
            if failure == .unauthorized { phase = .blocked(failure?.localizedDescription ?? "") }
        }
    }

    // MARK: - Session detail

    func history(agentId: String, limit: Int? = nil) async throws -> [AgentEvent] {
        try await client.history(agentId: agentId, limit: limit)
    }

    /// A session's file changes. The live snapshot's window loses the diff off
    /// an edit within minutes, so the Changes tab reads this rather than the
    /// events it already has.
    func loadChanges(agentId: String) async {
        guard let changes = try? await client.changes(agentId: agentId) else { return }
        sessionChanges[agentId] = changes
    }

    /// Whether this session's changes have been fetched at all. "0 files
    /// changed" and "not asked yet" are different sentences.
    func changesLoaded(agentId: String) -> Bool { sessionChanges[agentId] != nil }

    func loadSlashCommands(agentId: String) async {
        guard slashCommands[agentId] == nil else { return }
        guard let commands = try? await client.slashCommands(agentId: agentId) else { return }
        slashCommands[agentId] = commands
    }

    // MARK: - Usage

    /// Keeps the last good read under a failure: a usage screen that empties
    /// itself the moment the tailnet blinks is less useful than a stale one
    /// that says so.
    func loadAnalytics(range: AnalyticsRange, project: String?) {
        analyticsTask?.cancel()
        let previous = analytics.data
        if previous == nil { analytics = .loading }
        analyticsTask = Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await client.analytics(range: range.rawValue, project: project)
                if Task.isCancelled { return }
                analytics = .ready(snapshot)
            } catch {
                if Task.isCancelled { return }
                analytics = .failed(message: BridgeError.from(error).localizedDescription, previous: previous)
            }
        }
    }

    func control(agentId: String, action: String, value: String? = nil, force: Bool = false) async throws {
        try await client.control(agentId: agentId, action: action, value: value, force: force)
        await refresh()
    }

    func answer(agentId: String, requestId: String, question: String, answer: String) async throws {
        try await client.answer(agentId: agentId, requestId: requestId, question: question, answer: answer)
        await refresh()
    }

    // MARK: - Start a session

    /// Which runtimes the bridge can host, so the start sheet only shows what is real.
    func managedRuntimes() async throws -> [ManagedRuntime] {
        try await client.managedRuntimes()
    }

    /// Starts a bridge-hosted Claude session. The new session arrives through
    /// the live stream like any other; the refresh makes the deck show it now.
    @discardableResult
    func startManagedSession(
        cwd: String,
        project: String,
        objective: String,
        prompt: String,
        permissionMode: String?
    ) async throws -> String {
        let session = try await client.startManagedSession(
            request: ManagedSessionRequest(
                project: project,
                cwd: cwd,
                model: nil,
                objective: objective.isEmpty ? nil : objective,
                prompt: prompt.isEmpty ? nil : prompt,
                permissionMode: permissionMode
            )
        )
        await refresh()
        return session.agentId
    }
}
