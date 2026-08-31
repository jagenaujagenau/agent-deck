import Foundation

/// One line saying why a session wants attention, or what it is doing.
///
/// Mirrored from the Android shared module so the surfaces agree. A card that
/// reads "Review required" on one and shows a raw internal task string on
/// another is two answers to the same question.
func agentCardActivity(_ agent: Agent) -> String {
    if agent.state == "waiting" {
        switch openRequest(agent) {
        case .approval: return "Review required"
        case .question: return "Awaiting your answer"
        case nil: break
        }
        let remotelyMessageable = ["prompt", "steer", "follow_up"]
            .contains { supportsCapability(agent.capabilities, $0) }
        return remotelyMessageable ? "Open session to continue" : "Input required in host runtime"
    }
    switch agent.state {
    case "running":
        // A green "working" over minutes of silence is the deck vouching for
        // something it cannot see; say the silence instead.
        if let minutes = signalSilenceMinutes(agent) { return "No signal for \(minutes)m" }
        if agent.task.hasPrefix("Using ") { return agent.task }
        if agent.task.hasSuffix(" completed") { return String(agent.task.dropLast(" completed".count)) + " finished" }
        if agent.task.isEmpty || agent.task == agent.objective { return "Working on instruction" }
        return agent.task
    case "paused":
        return "Paused by user"
    case "error":
        return agent.task.isEmpty ? "Run failed" : agent.task
    case "offline":
        return "Session ended"
    case "idle":
        let ready: Set<String> = ["ready", "ready for an instruction"]
        return ready.contains(agent.task.lowercased()) ? "Ready for an instruction" : "Turn completed"
    default:
        return agent.task.isEmpty ? "No recent activity" : agent.task
    }
}

/// Which control action delivers a typed message to this session, or nil when
/// the runtime advertises none.
func remoteMessageAction(state: String, capabilities: [String]?) -> String? {
    let supports = { (action: String) in supportsCapability(capabilities, action) }
    if ["running", "waiting"].contains(state), supports("steer") { return "steer" }
    if ["running", "waiting"].contains(state), supports("follow_up") { return "follow_up" }
    if supports("prompt") { return "prompt" }
    if supports("follow_up") { return "follow_up" }
    return nil
}

/// How long a running session has been silent, when that silence is worth
/// saying. A session claiming "running" whose runtime has produced nothing
/// for minutes is not confidently working — its agent may be hung, or its
/// hook pipe broken. Three minutes is past any honest thinking pause:
/// thoughts and tool calls both stream as events. Nil while the session is
/// not running, or while signal still flows. Mirrored from Android's
/// `signalSilenceMinutes` in the shared module.
func signalSilenceMinutes(_ agent: Agent, now: Date = Date()) -> Int? {
    guard agent.state == "running" else { return nil }
    guard let latest = Timestamps.parse(SeenPolicy.activityAt(agent)) else { return nil }
    let minutes = Int(now.timeIntervalSince(latest) / 60)
    return minutes >= 3 ? minutes : nil
}
