import Foundation

/// How the deck is grouped, and which groups are asking for a person.
/// Mirrored from `apps/android/mobile/.../HomePolicy.kt`.
///
/// Case order is the shared attention ranking (`attentionPriority`): the stuck
/// one is always first, blocked next, then "finished while you weren't
/// looking", and only then what is merely running. `done` is exactly
/// idle-and-unseen; a completion that has been read files under Completed or
/// History like it always did.
enum HomeAgentState: Int, CaseIterable {
    case failed, approvalRequired, question, inputRequired, done, running, paused, recentlyCompleted, history

    var label: String {
        switch self {
        case .approvalRequired: "Approval required"
        case .question: "Question"
        case .inputRequired: "Input required"
        case .failed: "Failed"
        case .done: "Done"
        case .running: "Running"
        case .paused: "Paused"
        case .recentlyCompleted: "Completed"
        case .history: "History"
        }
    }

    var sectionLabel: String {
        switch self {
        case .approvalRequired: "APPROVALS"
        case .question: "QUESTIONS"
        case .inputRequired: "INPUT REQUIRED"
        case .failed: "FAILED"
        case .done: "DONE"
        case .running: "RUNNING"
        case .paused: "PAUSED"
        case .recentlyCompleted: "RECENTLY COMPLETED"
        case .history: "HISTORY"
        }
    }

    /// Whether this state is a session asking for a person. Amber is reserved
    /// for exactly this set and nothing else.
    var attention: Bool {
        switch self {
        case .approvalRequired, .question, .inputRequired, .failed: true
        default: false
        }
    }
}

enum HomeFilter: String, CaseIterable, Identifiable {
    case now, attention, history

    var id: String { rawValue }

    var label: String {
        switch self {
        case .now: "Now"
        case .attention: "Needs you"
        case .history: "History"
        }
    }

    func includes(_ state: HomeAgentState) -> Bool {
        switch self {
        case .now: state != .history
        case .attention: state.attention
        case .history: state == .history
        }
    }
}

/// An archived session is filed under History whatever it is doing.
///
/// Putting something away is a statement about wanting it off the deck, not
/// about the runtime — which goes on running, and goes on being reported to
/// every other surface. Mirrored from Android's `homeAgentState(agent, archived, now)`.
func homeAgentState(_ agent: Agent, archived: Bool, seen: Bool = true, now: Date = Date()) -> HomeAgentState {
    archived ? .history : homeAgentState(agent, seen: seen, now: now)
}

func homeAgentState(_ agent: Agent, seen: Bool = true, now: Date = Date()) -> HomeAgentState {
    if agent.state == "waiting", agent.pendingApproval != nil { return .approvalRequired }
    // The durable request is authoritative; the event window is a fallback for
    // a bridge that predates `pendingQuestion`.
    if agent.state == "waiting",
       agent.pendingQuestion != nil || agent.events.contains(where: { $0.kind == "question" }) {
        return .question
    }
    if agent.state == "waiting" { return .inputRequired }
    if agent.state == "error" { return .failed }
    if agent.state == "running" { return .running }
    if agent.state == "paused" { return .paused }
    // Unseen wins over the ten-minute window: a finish nobody has looked at is
    // still news however long ago it landed.
    if agent.state == "idle", !seen { return .done }
    if agent.state == "idle",
       let heartbeat = Timestamps.parse(agent.lastSeenAt),
       now.timeIntervalSince(heartbeat) < 10 * 60 {
        return .recentlyCompleted
    }
    return .history
}

/// Mutable heartbeats and activity text never affect ordering within a
/// presentation state — otherwise a card would hop while you read it.
///
/// The section order *is* `attentionPriority` — the enum's cases are declared
/// in that ranking. Within a project's run of a section the priority sorts
/// again, so that inside History a filed-away session that finished unseen
/// still floats above the ones already read. It sorts after the project, not
/// before it, because a project's run splitting in two would mint two groups
/// with the same identity.
func homeAgentOrder(_ agents: [Agent], archived: Set<String> = [], seen: (Agent) -> Bool = { _ in true }, now: Date = Date()) -> [Agent] {
    agents.sorted { first, second in
        let a = homeAgentState(first, archived: archived.contains(first.id), seen: seen(first), now: now).rawValue
        let b = homeAgentState(second, archived: archived.contains(second.id), seen: seen(second), now: now).rawValue
        if a != b { return a < b }
        let pa = first.project.lowercased()
        let pb = second.project.lowercased()
        if pa != pb { return pa < pb }
        let ra = attentionPriority(state: first.state, blocked: first.state == "waiting", seen: seen(first))
        let rb = attentionPriority(state: second.state, blocked: second.state == "waiting", seen: seen(second))
        if ra != rb { return ra > rb }
        return first.id < second.id
    }
}

/// One rendered group of the deck: a state, a project, and the sessions in it.
struct DeckGroup: Identifiable {
    var state: HomeAgentState
    var project: String
    var agents: [Agent]
    var id: String { "\(state.rawValue)/\(project)" }
}

/// Sections by state, then by project inside each, in the order
/// `homeAgentOrder` already put them.
func deckGroups(_ agents: [Agent], filter: HomeFilter, archived: Set<String> = [], seen: (Agent) -> Bool = { _ in true }, now: Date = Date()) -> [DeckGroup] {
    var groups: [DeckGroup] = []
    for agent in homeAgentOrder(agents, archived: archived, seen: seen, now: now) {
        let state = homeAgentState(agent, archived: archived.contains(agent.id), seen: seen(agent), now: now)
        guard filter.includes(state) else { continue }
        if let last = groups.indices.last, groups[last].state == state, groups[last].project == agent.project {
            groups[last].agents.append(agent)
        } else {
            groups.append(DeckGroup(state: state, project: agent.project, agents: [agent]))
        }
    }
    return groups
}
