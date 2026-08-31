import Foundation

/// The one Request a session is waiting on, if any.
///
/// A Request is opened by a runtime and resolved exactly once — but "is this
/// session asking me something" was answered five different ways across the
/// two apps, and the answers had already diverged: one phone showed a
/// question card for an ask the runtime had moved past, the other did not;
/// one stacked an approval and a question, the other showed the approval
/// alone. This is that question, asked once. Mirrored from Android's
/// `OpenRequest.kt`; parity is pinned by the corpus's `openRequest` section.
///
/// Two rules settle it. An approval outranks a question, because an approval
/// is the one holding a tool call open — the same precedence the bridge's own
/// `pendingBlockFrom` uses. And a question counts as open only when the
/// durable Request says so, or when it is the newest thing the session did:
/// an ask buried under later tool calls is one the runtime answered for
/// itself.
enum OpenRequest: Equatable {
    case approval(PendingApproval)
    case question(PendingQuestion, event: AgentEvent?)

    var id: String {
        switch self {
        case .approval(let approval): approval.id
        case .question(let question, _): question.id
        }
    }
}

/// The text an event-derived question asks, preferring its summary over its
/// explanatory detail.
private func questionText(_ event: AgentEvent) -> String {
    if !event.summary.trimmed.isEmpty, event.summary.caseInsensitiveCompare("Question") != .orderedSame {
        return event.summary
    }
    return event.detail?.trimmed.nonEmpty ?? "Agent has a question"
}

/// What this session is waiting on. Nil unless the Agent is waiting, and nil
/// for a durable Request whose expiry has passed — an ask nobody can answer
/// any more is not an open Request.
func openRequest(_ agent: Agent, now: Date = Date()) -> OpenRequest? {
    guard agent.state == "waiting" else { return nil }
    func live(_ expiresAt: String) -> Bool {
        guard let at = Timestamps.parse(expiresAt) else { return true }
        return at > now
    }
    if let approval = agent.pendingApproval, live(approval.expiresAt) {
        return .approval(approval)
    }
    if let question = agent.pendingQuestion, live(question.expiresAt) {
        return .question(question, event: nil)
    }
    // No durable Request: the newest event may still be an unanswered ask.
    guard let newest = agent.events.max(by: { $0.createdAt < $1.createdAt }), newest.kind == "question" else {
        return nil
    }
    return .question(
        PendingQuestion(
            id: newest.id,
            question: questionText(newest),
            options: newest.options,
            createdAt: newest.createdAt,
            expiresAt: ""
        ),
        event: newest
    )
}
