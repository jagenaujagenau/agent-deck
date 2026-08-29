import Foundation

/// One subagent's run, assembled from the events it produced.
///
/// Derived rather than reported: the bridge stores no subagent record, only
/// events that carry the id and type of whichever subagent made them. That is
/// enough to reconstruct a run, and it means nothing has to be kept in sync
/// with a second source of truth.
///
/// Mirrored from `apps/android/shared/.../Subagents.kt`.
struct SubagentRun: Identifiable, Equatable {
    var id: String
    /// The runtime's own word for it — "general-purpose", "Explore".
    var type: String
    /// What the run was asked to do — "Fix lint in apps/server". The spawn
    /// event carries it; sessions observed by an older adapter have none.
    var name: String?
    var startedAt: String
    var lastAt: String
    /// What it is doing, or the last thing it did.
    var activity: String
    var eventCount: Int
    var finished: Bool

    /// What a row or lens header calls this run. Five parallel
    /// "general-purpose" runs are told apart by their errand, not their kind.
    var title: String { name ?? type }
}

/// The hook publishes a subagent's last breath under this summary.
private func isCompletion(_ event: AgentEvent) -> Bool {
    event.tool == "Task" && event.summary.lowercased().hasSuffix("subagent finished")
}

/// Every subagent that has produced an event in this session, oldest first.
///
/// Ordered by when each started rather than by recency, so a list read twice in
/// a row names them in the same order — a session with three of them running is
/// exactly when a jumping list is least welcome.
func subagentRuns(_ events: [AgentEvent]) -> [SubagentRun] {
    var order: [String] = []
    var byId: [String: [AgentEvent]] = [:]
    for event in events {
        guard let id = event.subagentId else { continue }
        if byId[id] == nil { order.append(id) }
        byId[id, default: []].append(event)
    }
    return order.compactMap { id -> SubagentRun? in
        guard let own = byId[id] else { return nil }
        let ordered = own.sorted { $0.createdAt < $1.createdAt }
        guard let first = ordered.first, let last = ordered.last else { return nil }
        return SubagentRun(
            id: id,
            type: ordered.compactMap { $0.subagentType }.first { !$0.trimmed.isEmpty } ?? "Subagent",
            name: ordered.compactMap { $0.subagentName }.first { !$0.trimmed.isEmpty },
            startedAt: first.createdAt,
            lastAt: last.createdAt,
            // A completion event's summary is "<type> subagent finished", which
            // says nothing a finished run does not already say. The work it did
            // last is the more useful line.
            activity: ordered.last { !isCompletion($0) }?.summary ?? last.summary,
            eventCount: ordered.count,
            finished: ordered.contains(where: isCompletion)
        )
    }
    .sorted { $0.startedAt < $1.startedAt }
}

/// What the picker can narrow the run list to.
enum SubagentFilter {
    case all, running, done
}

/// Where the picker opens: on the running work when there is any, on everything
/// otherwise. Mid-flight the reason to open the sheet is almost always a live
/// lens; once everything has finished, it is review.
/// Mirrored from `Subagents.kt` `defaultSubagentFilter`.
func defaultSubagentFilter(_ runs: [SubagentRun]) -> SubagentFilter {
    runs.contains { !$0.finished } ? .running : .all
}

/// The runs a filter shows, grouped but never reshuffled: running above done,
/// each group in the stable started order `subagentRuns` promises — a row only
/// moves when its status actually changes. The selected run is always shown,
/// whatever the filter: a picker must not hide the thing it has a check on.
/// Mirrored from `Subagents.kt` `filteredSubagentRuns`.
func filteredSubagentRuns(
    _ runs: [SubagentRun],
    filter: SubagentFilter,
    selectedId: String? = nil
) -> [SubagentRun] {
    let visible = runs.filter { run in
        if run.id == selectedId { return true }
        switch filter {
        case .all: return true
        case .running: return !run.finished
        case .done: return run.finished
        }
    }
    return visible.filter { !$0.finished } + visible.filter { $0.finished }
}

/// The session as one subagent saw it.
///
/// Its own events only — not the parent's, and not a sibling's. Passing the
/// result to the same views the whole session uses is what lets a subagent be
/// read with the screens already built rather than a second set of them.
func eventsOfSubagent(_ events: [AgentEvent], subagentId: String) -> [AgentEvent] {
    events.filter { $0.subagentId == subagentId }
}
