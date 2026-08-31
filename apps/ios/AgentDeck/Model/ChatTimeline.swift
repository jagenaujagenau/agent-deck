import Foundation

/// The whole session as one conversation.
///
/// A session is words and work: what was said, and what the agent did between
/// the sayings. The old reading split those across tabs — chat here, tools
/// there, thoughts somewhere else — so no screen ever showed what actually
/// happened. This fold keeps the words as messages and gathers every run of
/// work between them into one cluster, in order, the way the session was
/// lived. Mirrored from Android's `ChatTimeline.kt`; parity is enforced by
/// the corpus's `timeline` section (`fixtures/attention-parity.json`).
enum TimelineItem: Identifiable {
    /// Someone speaking: the person's instruction or the agent's reply.
    case message(ConversationEntry)

    /// A run of work between words — tools, thoughts, warnings — one cluster.
    case activity([AgentEvent])

    var id: String { "item:\(leadEvent.id)" }

    /// The event the item leads with — what separators and list keys anchor on.
    var leadEvent: AgentEvent {
        switch self {
        case .message(let entry): entry.event
        case .activity(let events): events[0]
        }
    }

    /// The item's newest event — what "did anything change" comparisons anchor on.
    var newestEvent: AgentEvent {
        switch self {
        case .message(let entry): entry.event
        case .activity(let events): events[events.count - 1]
        }
    }
}

func chatTimeline(_ events: [AgentEvent]) -> [TimelineItem] {
    let sorted = events.sorted { $0.createdAt < $1.createdAt }
    let messages = Dictionary(
        conversationEntries(sorted).map { ($0.event.id, $0) },
        uniquingKeysWith: { first, _ in first }
    )
    var items: [TimelineItem] = []
    var cluster: [AgentEvent] = []
    func flush() {
        if !cluster.isEmpty {
            items.append(.activity(cluster))
            cluster.removeAll()
        }
    }
    for event in sorted {
        if let message = messages[event.id] {
            flush()
            items.append(.message(message))
        } else if isActivity(event) {
            cluster.append(event)
        }
    }
    flush()
    return items
}

/// What earns a row in a work cluster: things the agent did. The person's own
/// words never do (they are messages or duplicates of one), and neither does
/// harness plumbing that an adapter published as an event.
private func isActivity(_ event: AgentEvent) -> Bool {
    if event.kind == "user" { return false }
    if event.kind == "thought", event.summary == "Received instruction" { return false }
    if (event.detail ?? "").trimmed.hasPrefix("<task-notification>") { return false }
    return ["tool", "thought", "warning", "error", "output", "question"].contains(event.kind)
}

/// A cluster's total diff, summed from every step that carried one. Counts
/// the diff's own +/− lines (file headers excluded), so the label agrees with
/// the diff a tap reveals. Mirrored from Android's `ChatTimeline.kt`.
struct DiffStat: Equatable {
    var added: Int
    var removed: Int
}

func diffStat(_ events: [AgentEvent]) -> DiffStat? {
    var added = 0
    var removed = 0
    var any = false
    for event in events {
        guard let diff = event.diff?.nonEmpty else { continue }
        any = true
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+++") || line.hasPrefix("---") { continue }
            if line.hasPrefix("+") { added += 1 } else if line.hasPrefix("-") { removed += 1 }
        }
    }
    return any ? DiffStat(added: added, removed: removed) : nil
}

/// The collapsed cluster's one line: what the work amounted to, said the way
/// a person would — "Ran 11 commands, edited 2 files", not a tool census.
/// The verbs come from what each step actually was; a run of nothing nameable
/// falls back to counting steps. Mirrored from Android's `ChatTimeline.kt`.
/// The tools that look things up rather than change them. A Grep hit carries
/// a path, but nothing was edited.
private let searchTools: Set<String> = ["Grep", "Glob", "WebSearch", "WebFetch"]

func activitySummary(_ events: [AgentEvent]) -> String {
    let commands = events.filter { !($0.command ?? "").trimmed.isEmpty || $0.tool == "Bash" }.count
    let searches = events.filter { searchTools.contains($0.tool ?? "") }.count
    let paths = events.filter { !($0.path ?? "").trimmed.isEmpty && !searchTools.contains($0.tool ?? "") }
    let created = Set(paths.filter { $0.tool == "Write" }.compactMap(\.path)).count
    let read = Set(paths.filter { $0.tool == "Read" }.compactMap(\.path)).count
    let edited = Set(paths.filter { $0.tool != "Write" && $0.tool != "Read" }.compactMap(\.path)).count
    let thoughts = events.filter { $0.kind == "thought" }.count
    func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }
    var parts: [String] = []
    if commands > 0 { parts.append("ran \(commands == 1 ? "1 command" : "\(commands) commands")") }
    if edited > 0 { parts.append("edited \(files(edited))") }
    if created > 0 { parts.append("created \(files(created))") }
    if read > 0 { parts.append("read \(files(read))") }
    if searches > 0 { parts.append("searched \(searches == 1 ? "once" : "\(searches) times")") }
    if parts.isEmpty, thoughts > 0 {
        parts.append(thoughts == 1 ? "thought once" : "thought \(thoughts) times")
    }
    let line = parts.isEmpty
        ? "\(events.count) \(events.count == 1 ? "step" : "steps")"
        : parts.joined(separator: ", ")
    return line.prefix(1).uppercased() + line.dropFirst()
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// One entry of the conversation map: an exchange, said small.
///
/// A phone chat holding two hundred turns has no scrollbar worth the name.
/// The map is the table of contents a long conversation earns — one row per
/// thing the person asked, with how the agent left it — and each row knows
/// the event the timeline can scroll to. Mirrored from `ChatTimeline.kt`.
struct ConversationMarker: Identifiable, Equatable {
    /// The user message's event id — the timeline item to scroll to.
    var id: String
    var prompt: String
    /// How the exchange ended: the last reply before the next ask, if any.
    var reply: String?
    var at: String
}

func conversationMarkers(_ events: [AgentEvent]) -> [ConversationMarker] {
    var markers: [ConversationMarker] = []
    var prompt: ConversationEntry?
    var reply: ConversationEntry?
    func flush() {
        if let asked = prompt {
            markers.append(ConversationMarker(
                id: asked.event.id,
                prompt: markerPreview(asked.content),
                reply: reply.map { markerPreview($0.content) },
                at: asked.event.createdAt
            ))
        }
        prompt = nil
        reply = nil
    }
    for entry in conversationEntries(events) {
        if entry.role == .user {
            flush()
            prompt = entry
        } else if prompt != nil {
            reply = entry
        }
    }
    flush()
    return markers
}

/// A message reduced to one plain line: markdown dressing stripped, code
/// blocks named rather than quoted, clipped at a word.
func markerPreview(_ text: String, limit: Int = 96) -> String {
    var line = text
    for (pattern, replacement) in [
        ("```[\\s\\S]*?(```|$)", " code "),
        ("`([^`]*)`", "$1"),
        ("!?\\[([^\\]]*)\\]\\([^)]*\\)", "$1"),
        ("(?m)^\\s{0,3}(#{1,6}|>|[-+*]|\\d+[.)])\\s+", ""),
        ("[*_]{1,3}", ""),
        ("\\s+", " "),
    ] {
        line = line.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    line = line.trimmed
    if line.count <= limit { return line }
    let clipped = String(line.prefix(limit - 1)).trimmed
    let atWord = clipped.range(of: " ", options: .backwards).map { String(clipped[..<$0.lowerBound]) } ?? clipped
    return atWord + "…"
}

/// How many steps of a run failed — worn on the cluster header so triage
/// needs no expansion. Mirrored from `ChatTimeline.kt`.
func failedSteps(_ events: [AgentEvent]) -> Int {
    events.filter { $0.kind == "error" }.count
}

/// A cluster's steps, partitioned into who did them.
///
/// A session that farms work out mixes its subagents' tool calls into its
/// own, and a flat list of forty steps hides that three belonged to a search
/// agent and thirty to a build agent. Consecutive runs of one subagent's
/// work become one segment, titled by what that run was asked to do, so the
/// steps sheet can fold each helper to a single line the way the cluster
/// itself folds into the conversation. Mirrored from `ChatTimeline.kt`.
struct ActivitySegment: Identifiable, Equatable {
    /// Nil for the session's own work.
    var subagentId: String?
    var title: String
    var events: [AgentEvent]
    var id: String { "segment:\(events[0].id)" }
}

func activitySegments(_ events: [AgentEvent]) -> [ActivitySegment] {
    var segments: [ActivitySegment] = []
    for event in events {
        if let last = segments.indices.last, segments[last].subagentId == event.subagentId {
            segments[last].events.append(event)
        } else {
            segments.append(ActivitySegment(
                subagentId: event.subagentId,
                title: event.subagentName ?? event.subagentType ?? "Subagent",
                events: [event]
            ))
        }
    }
    return segments
}

/// Whether a tool looks things up rather than changes them.
func isSearchTool(_ tool: String?) -> Bool {
    searchTools.contains(tool ?? "")
}

/// When the person last instructed — the boundary of the current pass. The
/// changes receipt leads with what this pass touched, because
/// mid-conversation the question is "what did it just do", not "what has
/// this session ever done". Mirrored from `ChatTimeline.kt`.
func latestInstructionAt(_ events: [AgentEvent]) -> String? {
    conversationEntries(events).last { $0.role == .user }?.event.createdAt
}

/// Where the news begins: the first timeline item this reader has not seen,
/// for the "New" divider a returning reader lands on. Nil when there is no
/// mark to compare against, nothing is new, or everything is — a divider
/// above the whole conversation marks nothing. Mirrored from `ChatTimeline.kt`.
func firstUnseenIndex(_ items: [TimelineItem], seenUpTo: String?) -> Int? {
    guard let seenUpTo, !seenUpTo.isEmpty else { return nil }
    guard let index = items.firstIndex(where: { $0.newestEvent.createdAt > seenUpTo }) else { return nil }
    return index == 0 ? nil : index
}
