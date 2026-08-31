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

/// The collapsed cluster's one line: what the work amounted to. Steps first —
/// the honest size of the run — then the tools that dominated it, then how
/// many files it touched.
func activitySummary(_ events: [AgentEvent]) -> String {
    var parts = ["\(events.count) \(events.count == 1 ? "step" : "steps")"]
    let counts = events.compactMap { $0.tool?.nonEmpty }.reduce(into: [String: Int]()) {
        $0[$1, default: 0] += 1
    }
    let tools = counts.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }
        .prefix(2)
        .map(\.key)
        .joined(separator: ", ")
    if !tools.isEmpty { parts.append(tools) }
    let files = Set(events.compactMap { $0.path?.nonEmpty }).count
    if files == 1 { parts.append("1 file") } else if files > 1 { parts.append("\(files) files") }
    return parts.joined(separator: " · ")
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
