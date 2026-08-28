import Foundation

/// One line saying why a session wants attention, or what it is doing.
///
/// Mirrored from the Android shared module so the surfaces agree. A card that
/// reads "Review required" on one and shows a raw internal task string on
/// another is two answers to the same question.
func agentCardActivity(_ agent: Agent) -> String {
    if agent.state == "waiting" {
        if agent.pendingApproval != nil { return "Review required" }
        if agent.pendingQuestion != nil || agent.events.contains(where: { $0.kind == "question" }) {
            return "Awaiting your answer"
        }
        let remotelyMessageable = ["prompt", "steer", "follow_up"]
            .contains { supportsCapability(agent.capabilities, $0) }
        return remotelyMessageable ? "Open session to continue" : "Input required in host runtime"
    }
    switch agent.state {
    case "running":
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
