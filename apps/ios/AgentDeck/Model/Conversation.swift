import Foundation

/// How a session's raw events become a conversation.
/// Mirrored from `apps/android/shared/.../AgentConversation.kt`.
enum ConversationRole { case user, agent }

struct ConversationEntry: Identifiable {
    var event: AgentEvent
    var role: ConversationRole
    var content: String
    var id: String { event.id }
}

func conversationEntries(_ events: [AgentEvent]) -> [ConversationEntry] {
    let ordered = events.sorted { $0.createdAt < $1.createdAt }
    let entries: [ConversationEntry] = ordered.compactMap { event in
        let userMessage = event.summary.hasPrefix("Remote command:")
            || event.kind == "user"
            || (event.kind == "thought" && event.summary == "Received instruction")
        if userMessage, let detail = event.detail, !detail.trimmed.isEmpty {
            // A raw task-notification is harness plumbing an older adapter
            // published as the person speaking; the parsed copy exists alongside.
            if detail.trimmed.hasPrefix("<task-notification>") { return nil }
            return ConversationEntry(event: event, role: .user, content: detail.trimmed)
        }
        guard isAgentResponse(event) else { return nil }
        let content = (event.detail ?? event.summary).trimmed
        return content.isEmpty ? nil : ConversationEntry(event: event, role: .agent, content: content)
    }
    // A message delivered remotely is echoed back by the runtime moments later.
    // Two copies of the same sentence is the surface's mistake, not the user's.
    return entries.reduce(into: [ConversationEntry]()) { result, entry in
        if let previous = result.last,
           previous.role == .user, entry.role == .user,
           previous.content == entry.content,
           closeInTime(previous.event.createdAt, entry.event.createdAt) {
            return
        }
        result.append(entry)
    }
}

/// Whether `current` opens a new exchange: the person spoke, or both events
/// carry turnIds and they differ. An untagged event stays with the thread it
/// follows — the bridge tags where it can, and a gap is not a boundary.
///
/// Mirrors the SDK's `turnThreads` (`packages/bridge-client/src/events.ts`) and
/// Android's `startsNewTurn` (`apps/android/shared/.../AgentConversation.kt`);
/// keep the three in step.
func startsNewTurn(previous: AgentEvent?, current: AgentEvent) -> Bool {
    guard let previous else { return true }
    if current.kind == "user" { return true }
    return current.turnId != nil && previous.turnId != nil && current.turnId != previous.turnId
}

func reasoningEvents(_ events: [AgentEvent]) -> [AgentEvent] {
    events
        .sorted { $0.createdAt < $1.createdAt }
        .filter { $0.kind == "thought" && $0.summary != "Received instruction" && !($0.detail ?? "").trimmed.isEmpty }
}

/// The bridge's retained history plus anything the live snapshot has that has
/// not been fetched yet.
///
/// The live copy is fresher and normally wins, but the snapshot is a lossy view
/// of the same event: it clips `detail` so a card stays small, and drops
/// `command` and `diff` outright. Taking it wholesale replaces a whole message
/// with its first few hundred characters.
func mergeSessionEvents(history: [AgentEvent], live: [AgentEvent]) -> [AgentEvent] {
    if history.isEmpty { return live.sorted { $0.createdAt < $1.createdAt } }
    var byId: [String: AgentEvent] = [:]
    for event in history { byId[event.id] = event }
    for event in live {
        guard let known = byId[event.id] else {
            byId[event.id] = event
            continue
        }
        var merged = event
        if isClippedForm(live: event.detail, full: known.detail) { merged.detail = known.detail }
        merged.command = event.command ?? known.command
        merged.diff = event.diff ?? known.diff
        byId[event.id] = merged
    }
    return byId.values.sorted { $0.createdAt < $1.createdAt }
}

/// Whether `live` is the snapshot's shortened form of `full`. The snapshot cuts
/// `detail` and marks the cut with an ellipsis, so its text is a prefix of what
/// history holds. Restoring only that exact shape leaves a genuine revision alone.
private func isClippedForm(live: String?, full: String?) -> Bool {
    guard let live, let full, live.hasSuffix("\u{2026}") else { return false }
    let prefix = String(live.dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
    return full.count > live.count && full.hasPrefix(prefix)
}

private func isAgentResponse(_ event: AgentEvent) -> Bool {
    // A subagent speaks exactly once, in the detail of the event reporting it
    // finished - and that event carries a tool ("Task"), so the guard below
    // threw away the only thing it ever said.
    if isSubagentMessage(event) { return true }
    guard event.kind == "output",
          !event.summary.hasPrefix("Remote command:"),
          event.tool == nil,
          event.command == nil
    else { return false }
    if event.summary == "Response" { return true }
    if !(event.detail ?? "").trimmed.isEmpty { return true }
    return event.summary != "Activity" && !event.summary.hasSuffix(" completed")
}

private func isSubagentMessage(_ event: AgentEvent) -> Bool {
    event.subagentId != nil && event.tool == "Task" && !(event.detail ?? "").trimmed.isEmpty
}

private func closeInTime(_ first: String, _ second: String) -> Bool {
    guard let a = Timestamps.parse(first), let b = Timestamps.parse(second) else { return false }
    return abs(a.timeIntervalSince(b)) < 10
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
