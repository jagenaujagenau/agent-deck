import Foundation

/// Everything this app asks of the bridge, over `URLSession` and `Codable`.
///
/// Endpoints mirror `apps/android/shared/.../BridgeClient.kt` exactly — the
/// bridge is one contract, and a surface that invents its own paths is a
/// surface that breaks on a bridge upgrade nobody told it about.
actor BridgeClient {
    private(set) var baseURL: String
    private var token: String

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        return decoder
    }()

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    /// A stream has no read timeout: a quiet deck is not a broken one. The
    /// bridge sends a ping every 15 seconds, which is what actually proves the
    /// connection is alive.
    private let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3_600
        configuration.timeoutIntervalForResource = 86_400
        return URLSession(configuration: configuration)
    }()

    init(baseURL: String = "", token: String = "") {
        self.baseURL = BridgeClient.normalize(baseURL)
        self.token = token.trimmed
    }

    func configure(baseURL: String, token: String) {
        self.baseURL = BridgeClient.normalize(baseURL)
        self.token = token.trimmed
    }

    // MARK: - Reads

    func snapshot() async throws -> BridgeSnapshot {
        try await get("/bridge/v1/snapshot")
    }

    /// A session's retained history. The live snapshot carries only a rolling
    /// window sized for cards, so on a busy session the conversation ages out
    /// of it — the session view reads it here instead.
    func history(agentId: String, limit: Int? = nil) async throws -> [AgentEvent] {
        let suffix = limit.map { "?limit=\($0)" } ?? ""
        let response: AgentHistory = try await get("/bridge/v1/agents/\(escape(agentId))/history\(suffix)")
        return response.events
    }

    func changes(agentId: String) async throws -> [AgentEvent] {
        let response: AgentChanges = try await get("/bridge/v1/agents/\(escape(agentId))/changes")
        return response.changes
    }

    /// The models this session will answer as, asked of the runtime. A session
    /// the bridge does not host has no list — its model belongs to the runtime
    /// that owns its terminal — and answers 404, which is an empty list here so
    /// a surface can simply not offer the control.
    func models(agentId: String) async throws -> [RuntimeModel] {
        do {
            let response: RuntimeModels = try await get("/bridge/v1/agents/\(escape(agentId))/models")
            return response.models
        } catch BridgeError.http(404, _) {
            return []
        }
    }

    /// The message commands still queued for this session — the sender's to
    /// take back until the runtime collects them.
    func queuedMessages(agentId: String) async throws -> [QueuedCommand] {
        let response: QueuedCommands = try await get("/bridge/v1/agents/\(escape(agentId))/queued")
        return response.commands
    }

    /// Withdraws a queued message. A 404 means the runtime already collected
    /// it — the dock refreshes and the row disappears either way.
    func cancelQueued(agentId: String, commandId: String) async throws {
        do {
            _ = try await checked(
                try build("/bridge/v1/agents/\(escape(agentId))/queued/\(escape(commandId))", method: "DELETE"))
        } catch BridgeError.http(404, _) {
            // Already delivered; nothing left to withdraw.
        }
    }

    /// The `/` commands this runtime advertises. A runtime that publishes none
    /// answers with an empty catalog rather than a failure, so an empty list is
    /// an answer and not a swallowed error.
    func slashCommands(agentId: String) async throws -> [SlashCommand] {
        let catalog: SlashCommandCatalog = try await get("/bridge/v1/agents/\(escape(agentId))/slash-commands")
        return catalog.commands
    }

    /// Usage over a window. The time zone is the phone's, because "active days"
    /// and the heatmap's rows are calendar facts and a day boundary computed in
    /// UTC puts a late evening's work on tomorrow.
    func analytics(range: String, project: String?) async throws -> AnalyticsSnapshot {
        var components = URLComponents(string: baseURL + "/bridge/v1/analytics")
        var items = [
            URLQueryItem(name: "range", value: range),
            URLQueryItem(name: "timeZone", value: TimeZone.current.identifier),
        ]
        if let project { items.append(URLQueryItem(name: "project", value: project)) }
        components?.queryItems = items
        guard let url = components?.url else { throw BridgeError.unreachable("\(baseURL) is not a URL.") }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return try decode(AnalyticsSnapshot.self, from: try await checked(request))
    }

    // MARK: - Writes

    /// Pairing is the one call made before a credential exists, so it carries
    /// no Authorization header at all.
    func pair(code: String, deviceName: String) async throws -> PairedDevice {
        let request = try build("/bridge/v1/pair", method: "POST", body: PairRequest(code: code, deviceName: deviceName), authorized: false)
        let (data, response) = try await perform(request, on: session)
        guard let http = response as? HTTPURLResponse else { throw BridgeError.malformed("No HTTP response") }
        guard (200 ..< 300).contains(http.statusCode) else {
            // The bridge answers 401 for a code that is wrong or has expired,
            // and 400 for one that is not six digits. Both are the code's
            // fault, and neither is worth a status number on screen.
            if http.statusCode == 401 { throw BridgeError.http(401, "That pairing code is invalid or expired.") }
            if http.statusCode == 400 { throw BridgeError.http(400, "A pairing code is six digits.") }
            throw BridgeError.http(http.statusCode, message(from: data))
        }
        return try decode(PairedDevice.self, from: data)
    }

    /// `force` is the explicit way past a 409: the bridge refuses to deliver a
    /// message to a session blocked on an approval or question unless the body
    /// says the sender saw that and meant it anyway.
    func control(agentId: String, action: String, value: String? = nil, commandId: String? = nil, force: Bool = false) async throws {
        let request = try build(
            "/bridge/v1/agents/\(escape(agentId))/control",
            method: "POST",
            body: ControlRequest(action: action, value: value, commandId: commandId, force: force ? true : nil)
        )
        _ = try await checked(request)
    }

    /// Answers a durable question. Only `answered` is a device's to send; the
    /// bridge refuses any other status from a paired credential with 403.
    func answer(agentId: String, requestId: String, question: String, answer: String) async throws {
        let request = try build(
            "/bridge/v1/agents/\(escape(agentId))/requests/\(escape(requestId))/resolve",
            method: "POST",
            body: ResolveRequest(value: [question: answer])
        )
        _ = try await checked(request)
    }

    /// Tells the bridge a person is looking at this session right now, so the
    /// other surfaces stop badging it. Read scope, no body — a view is a read,
    /// and the bridge stamps the moment itself.
    func markSeen(agentId: String) async throws {
        _ = try await checked(try build("/bridge/v1/agents/\(escape(agentId))/seen", method: "POST"))
    }

    /// Dismisses a session from the deck. Its history, usage and file changes
    /// are kept on the bridge — this declutters the live list, it does not
    /// erase what the session did. One still heartbeating simply reappears on
    /// its next beat.
    func dismiss(agentId: String) async throws {
        _ = try await checked(try build("/bridge/v1/agents/\(escape(agentId))", method: "DELETE"))
    }

    // MARK: - Managed sessions

    /// Which runtimes the bridge can host and run itself.
    func managedRuntimes() async throws -> [ManagedRuntime] {
        let response: ManagedRuntimes = try await get("/bridge/v1/managed/runtimes")
        return response.runtimes
    }

    /// Starts a bridge-hosted Claude session. `cwd` must be absolute on the
    /// bridge's machine, so the caller offers only paths a person knows it can
    /// reach — the bridge is the one that has to find the directory.
    func startManagedSession(request: ManagedSessionRequest) async throws -> StartedManagedSession {
        let urlRequest = try build("/bridge/v1/managed/claude/sessions", method: "POST", body: request)
        let data = try await checked(urlRequest)
        return try decode(StartedManagedSession.self, from: data)
    }

    // MARK: - Live stream

    /// One full snapshot, then patches. A patch only makes sense against the
    /// snapshot it was computed from, so one that arrives before the first full
    /// send is dropped rather than guessed at.
    func streamSnapshots(onSnapshot: @Sendable @escaping (BridgeSnapshot) -> Void) async throws {
        var request = try build("/bridge/v1/events", method: "GET")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")

        let (bytes, response) = try await streamSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw BridgeError.malformed("No HTTP response") }
        if http.statusCode == 401 || http.statusCode == 403 { throw BridgeError.unauthorized }
        guard (200 ..< 300).contains(http.statusCode) else { throw BridgeError.http(http.statusCode, nil) }

        var eventName = ""
        var data = ""
        var latest: BridgeSnapshot?

        /// One complete record. Reset by the caller either way, so a record the
        /// stream does not name is dropped rather than applied as the last one.
        func dispatch() throws {
            defer { eventName = ""; data = "" }
            guard !data.isEmpty, let payload = data.data(using: .utf8) else { return }
            switch eventName {
            case "snapshot":
                let snapshot = try decode(BridgeSnapshot.self, from: payload)
                latest = snapshot
                onSnapshot(snapshot)
            case "patch":
                // A patch only makes sense against the snapshot it was computed
                // from, so one that arrives before the first full send is
                // dropped rather than guessed at.
                guard let previous = latest else { return }
                let merged = previous.applying(try decode(BridgeSnapshotPatch.self, from: payload))
                latest = merged
                onSnapshot(merged)
            default:
                return
            }
        }

        // Raw bytes rather than `bytes.lines`.
        //
        // `AsyncLineSequence` does not yield empty lines — and the blank line
        // between records is the *only* thing that ends an SSE event. Parsing
        // this stream through it means every record runs into the next one and
        // nothing is ever dispatched, which is exactly what happened: the deck
        // showed whatever `/snapshot` last returned and no live update ever
        // reached it, while the connection sat there looking healthy.
        var line: [UInt8] = []
        line.reserveCapacity(8 * 1024)

        func consume(_ raw: [UInt8]) throws {
            guard let text = String(bytes: raw, encoding: .utf8) else { return }
            if text.hasPrefix("event:") {
                eventName = String(text.dropFirst("event:".count)).trimmed
            } else if text.hasPrefix("data:") {
                data += String(text.dropFirst("data:".count)).trimmed
            } else if text.isEmpty {
                try dispatch()
            }
            // `id:`, `retry:` and `:` comments are the stream's own bookkeeping
            // and carry nothing this client acts on.
        }

        for try await byte in bytes {
            guard byte == UInt8(ascii: "\n") else {
                line.append(byte)
                continue
            }
            // Tolerate CRLF framing from anything sitting in front of the bridge.
            if line.last == UInt8(ascii: "\r") { line.removeLast() }
            try consume(line)
            line.removeAll(keepingCapacity: true)
        }
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await checked(try build(path, method: "GET"))
        return try decode(T.self, from: data)
    }

    private func checked(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await perform(request, on: session)
        guard let http = response as? HTTPURLResponse else { throw BridgeError.malformed("No HTTP response") }
        if http.statusCode == 401 || http.statusCode == 403 { throw BridgeError.unauthorized }
        guard (200 ..< 300).contains(http.statusCode) else {
            // A 409 whose body names `agent_blocked` is the bridge protecting a
            // pending approval or question from a message that would race it.
            // A distinct error, because the composer answers it with a choice
            // rather than a failure line. Any other 409 stays a plain refusal.
            if http.statusCode == 409, let detail = blockedDetail(from: data) {
                throw BridgeError.agentBlocked(detail)
            }
            throw BridgeError.http(http.statusCode, message(from: data))
        }
        return data
    }

    /// The bridge's `{ "error": "agent_blocked", "detail": "…" }` body, or nil
    /// when the 409 is about something else.
    private func blockedDetail(from data: Data) -> String? {
        struct Blocked: Decodable {
            var error: String
            var detail: String?
        }
        guard let body = try? JSONDecoder().decode(Blocked.self, from: data), body.error == "agent_blocked" else { return nil }
        return body.detail ?? ""
    }

    private func perform(_ request: URLRequest, on session: URLSession) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            throw BridgeError.from(error)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw BridgeError.malformed(String(describing: error))
        }
    }

    private func build(_ path: String, method: String, authorized: Bool = true) throws -> URLRequest {
        guard let url = URL(string: baseURL + path) else { throw BridgeError.unreachable("\(baseURL) is not a URL.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if authorized, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func build(_ path: String, method: String, body: some Encodable, authorized: Bool = true) throws -> URLRequest {
        var request = try build(path, method: method, authorized: authorized)
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }

    /// The bridge reports its own failures as `{"error": "..."}`; its wording
    /// is better than anything this app could invent for it.
    private func message(from data: Data) -> String? {
        struct Failure: Decodable { var error: String }
        return (try? JSONDecoder().decode(Failure.self, from: data))?.error
    }

    /// Fills in the scheme a person did not type.
    ///
    /// The two ways to reach a bridge look different, and the difference is
    /// exactly what says which scheme is meant. A direct one is an address and
    /// a port — `100.x.y.z:3000` — and speaks plain HTTP. A tailnet one is a
    /// MagicDNS name with no port, served over HTTPS by `tailscale serve`.
    ///
    /// Defaulting everything to `http://` sent a typed MagicDNS name to port
    /// 80, where nothing listens, and the app reported the bridge as out of
    /// range — which is true of port 80 and misleading about the bridge.
    static func normalize(_ value: String) -> String {
        var trimmed = value.trimmed
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        if trimmed.isEmpty { return "" }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") { return trimmed }
        return "\(hasExplicitPort(trimmed) ? "http" : "https")://\(trimmed)"
    }

    /// Whether the authority carries a `:port`. Guards against an IPv6 literal,
    /// which is full of colons and has none of them meaning a port.
    private static func hasExplicitPort(_ authority: String) -> Bool {
        let host = authority.split(separator: "/", maxSplits: 1).first.map(String.init) ?? authority
        if host.hasPrefix("[") { return host.contains("]:") }
        let parts = host.split(separator: ":")
        guard parts.count == 2 else { return false }
        return parts[1].allSatisfy(\.isNumber)
    }
}
