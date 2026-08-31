import Foundation

/// What a surface says about a session in one line.
///
/// These lived in a view file — outside the policy package the corpus tests
/// import — while their Kotlin twins lived private inside the phone's UI
/// file, so neither had a test and the two drifted: a blank-detail
/// instruction, a whitespace-only question, `objective` honoured on one
/// platform only, and two different reasoning-preview truncations. Shared
/// here, mirrored from Kotlin's `AgentActivity.kt`/`AgentCardPolicy.kt`, and
/// pinned by the corpus's `cardText` section.

func usefulTask(_ agent: Agent) -> String {
    let newest = { (kind: String) in
        agent.events.filter { $0.kind == kind }.max { $0.createdAt < $1.createdAt }
    }
    switch agent.state {
    case "waiting":
        if let approval = agent.pendingApproval { return approval.detail }
        if let question = agent.pendingQuestion {
            return question.question.trimmed.isEmpty ? "Agent has a question" : question.question
        }
        if let question = newest("question") {
            // The summary is the question; the detail is the note explaining it.
            if !question.summary.trimmed.isEmpty, question.summary != "Question" { return question.summary }
            if let detail = question.detail?.trimmed, !detail.isEmpty { return detail }
            return "Agent has a question"
        }
        return agent.task
    case "running", "paused":
        if let objective = agent.objective?.trimmed, !objective.isEmpty { return objective }
        // Blank-detail reports are skipped rather than accepted and rejected:
        // an instruction that says nothing is not the newest instruction, it
        // is noise in front of one.
        if let instruction = agent.events
            .filter({ $0.kind == "thought" && $0.summary == "Received instruction" && !($0.detail ?? "").trimmed.isEmpty })
            .max(by: { $0.createdAt < $1.createdAt })?.detail {
            return instruction
        }
        if let message = agent.events
            .filter({ $0.kind == "user" && !($0.detail ?? "").trimmed.isEmpty })
            .max(by: { $0.createdAt < $1.createdAt })?.detail {
            return message
        }
    case "offline":
        if let response = lastResponse(agent) { return "Last response · \(response)" }
        return "Session ended"
    case "idle":
        if ["done", "turn completed", "ready for an instruction"].contains(agent.task.lowercased()) {
            if let response = lastResponse(agent) { return "Last response · \(response)" }
            return "Turn completed"
        }
    default:
        break
    }
    if agent.task.hasSuffix(" completed") { return String(agent.task.dropLast(" completed".count)) + " finished · continuing" }
    if agent.task.hasPrefix("Using ") { return "Running " + String(agent.task.dropFirst("Using ".count)) }
    return agent.task
}

private func lastResponse(_ agent: Agent) -> String? {
    agent.events
        .filter { $0.kind == "output" && $0.summary == "Response" }
        .max { $0.createdAt < $1.createdAt }?
        .detail?.trimmed
        .nonEmpty
}

/// `Claude · orbital-api · 4f2a` ends in a short session hash. Kept as a
/// suffix on the title so two sessions in one project are told apart.
func sessionSuffix(_ agent: Agent) -> String {
    guard let fragment = agent.name.split(separator: "\u{00B7}").last else { return "" }
    let last = String(fragment).trimmed
    // ASCII hex only: `isHexDigit` accepts full-width and other Unicode hex
    // digits, which the Kotlin regex does not.
    guard last.count == 4, last.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return "" }
    return " \u{00B7} \(last)"
}

/// The chat's name. The project is the conversation a person recognises; the
/// short session suffix keeps two sessions in one project tellable apart, and
/// the harness only names the row when the session has no project at all.
func chatTitle(_ agent: Agent) -> String {
    (agent.project.isEmpty ? agent.harness.label : agent.project) + sessionSuffix(agent)
}

/// The preview line: the last thing said in this conversation. A session that
/// is asking shows its question; a running one shows what it is doing — the
/// "typing…" of an agent; otherwise the newest message speaks, prefixed
/// "You:" when the person spoke last, exactly as a chat list would.
/// Mirrored from `chatPreview` in the Android `MainActivity`.
func chatPreview(_ agent: Agent, state: HomeAgentState) -> String {
    // The old card wore a status chip that said "Approval required"; without
    // it, a bare command in amber would not say what is being asked of you.
    if state == .approvalRequired { return "Approve? \(usefulTask(agent))" }
    if state.attention || state == .failed { return usefulTask(agent) }
    // Silence outranks a stale train of thought: the newest reasoning of a
    // runtime that has gone mute reads as live work that is not happening.
    if state == .running, signalSilenceMinutes(agent) != nil { return agentCardActivity(agent) }
    if state == .running { return latestReasoningPreview(agent) ?? agentCardActivity(agent) }
    guard let last = conversationEntries(agent.events).last,
          let line = last.content
              .split(separator: "\n", omittingEmptySubsequences: true)
              .map({ String($0).trimmed })
              .first(where: { !$0.isEmpty })
    else { return usefulTask(agent) }
    return last.role == .user ? "You: \(line)" : line
}

/// Markdown reduced to the plain words a preview line can hold: links become
/// their text, code fences and inline code lose their marks, list and heading
/// markers go, emphasis unwraps twice (nested bold-italic), and whitespace
/// collapses. Mirrored from Kotlin's `stripMarkdownForPreview` — the Swift
/// side used to strip only backticks and asterisks, so the two previews of
/// one thought read differently.
func stripMarkdownForPreview(_ markdown: String) -> String {
    var value = markdown
    func sub(_ pattern: String, _ replacement: String) {
        value = value.replacingOccurrences(
            of: pattern, with: replacement, options: [.regularExpression])
    }
    sub("!\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
    sub("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
    sub("```[^\n]*", " ")
    value = value.replacingOccurrences(of: "```", with: " ")
    sub("`([^`]*)`", "$1")
    sub("(?m)^\\s{0,3}(?:#{1,6}|>|[-+*]|\\d+[.)])\\s+", "")
    sub("<[^>]+>", " ")
    for _ in 0 ..< 2 {
        sub("(?:\\*\\*|__)(.*?)(?:\\*\\*|__)", "$1")
        sub("(?:\\*|_)(.*?)(?:\\*|_)", "$1")
        sub("~~(.*?)~~", "$1")
    }
    sub("\\s+", " ")
    return value.trimmed
}

/// The current train of thought of a running session, clipped for a preview
/// line at a word boundary. Mirrored from `latestReasoningPreview` in the
/// Android `AgentCardPolicy`.
func latestReasoningPreview(_ agent: Agent, limit: Int = 120) -> String? {
    guard agent.state == "running" else { return nil }
    guard let thought = agent.events
        .filter({ $0.kind == "thought" && $0.summary != "Received instruction" })
        .max(by: { $0.createdAt < $1.createdAt })
    else { return nil }
    let reasoning = stripMarkdownForPreview(thought.detail ?? "")
    guard !reasoning.trimmed.isEmpty else { return nil }
    if reasoning.count <= limit { return reasoning }
    let clipped = String(reasoning.prefix(max(0, limit - 1))).trimmed
    let atWord = clipped.range(of: " ", options: .backwards).map { String(clipped[..<$0.lowerBound]) } ?? clipped
    return atWord + "…"
}
