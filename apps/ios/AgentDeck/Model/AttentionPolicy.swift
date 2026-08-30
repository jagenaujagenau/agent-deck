import Foundation

/// When a session is asking for a person, and whether that has been said yet.
///
/// Mirrored from `apps/android/shared/.../AttentionPolicy.kt`. Shared there
/// because the phone and the watch have to reach the same verdict from the same
/// snapshot; ported here for the same reason across platforms — two devices
/// disagreeing about whether something needs you is worse than either of them
/// being wrong alone, because afterwards neither can be trusted.
/// One ranking for "who on the deck deserves the eye first": the stuck one is
/// always first, and "finished while you weren't looking" outranks "running".
///
/// `blocked` means the runtime reports `waiting`; `seen` is this surface's own
/// record of whether the session has been looked at since it last did anything
/// (`SeenPolicy`). Kept equivalent with the Android app's ranking of the same
/// name — two surfaces disagreeing about what matters most is worse than
/// either ordering alone. Parity with AttentionRank.kt and attention.ts is
/// enforced by `packages/bridge-client/fixtures/attention-parity.json`, run
/// here by `apps/ios/PolicyTests` (`swift test`).
func attentionPriority(state: String, blocked: Bool, seen: Bool) -> Int {
    if state == "error" { return 5 }
    if blocked { return 4 }
    if state == "idle" { return seen ? 1 : 3 }
    if state == "running" { return 2 }
    // offline, and anything this app does not recognise, asks for nothing.
    return 0
}

enum AttentionPolicy {
    enum Action { case ignore, cancel, notify }

    struct Decision {
        var action: Action
        var observedAt: String
        var resolved: Bool
        var approvalKey: String?
    }

    /// The identity of the approval this session is blocked on, or nil.
    ///
    /// A runtime that cannot be answered remotely gets no key: a notification
    /// with two buttons that both fail is worse than silence.
    static func approvalKey(_ agent: Agent) -> String? {
        guard let approval = agent.pendingApproval else { return nil }
        guard supportsCapability(agent.capabilities, "approve"),
              supportsCapability(agent.capabilities, "reject") else { return nil }
        guard agent.state == "waiting" else { return nil }
        guard let expires = Timestamps.parse(approval.expiresAt), expires > Date() else { return nil }
        return "\(agent.id):\(approval.id)"
    }

    private static func attentionKey(_ agent: Agent) -> String? {
        if let key = approvalKey(agent) { return key }
        guard agent.state == "waiting" else { return nil }
        // The durable request carries the expiry the event window never had, so
        // an unanswered question cannot outlive its deadline here.
        if let question = agent.pendingQuestion {
            guard let expires = Timestamps.parse(question.expiresAt), expires > Date() else { return nil }
            return "\(agent.id):\(question.id)"
        }
        guard let newest = agent.events.max(by: { $0.createdAt < $1.createdAt }), newest.kind == "question" else { return nil }
        return "\(agent.id):\(newest.id)"
    }

    static func decide(agent: Agent, previousAt: String?, previousResolved: Bool, previousKey: String?) -> Decision {
        let newestEvent = agent.events.map(\.createdAt).max() ?? agent.lastSeenAt
        let observedAt = max(agent.lastSeenAt, newestEvent)
        let key = attentionKey(agent)

        // A snapshot older than one already seen decides nothing. Out-of-order
        // delivery is normal on a reconnect, and re-deciding on stale state is
        // how the same approval gets announced twice.
        if let previousAt, observedAt < previousAt {
            return Decision(action: .ignore, observedAt: previousAt, resolved: previousResolved, approvalKey: previousKey)
        }
        if previousAt == observedAt, previousResolved, key != nil {
            return Decision(action: .ignore, observedAt: previousAt ?? observedAt, resolved: previousResolved, approvalKey: previousKey)
        }
        let action: Action = {
            if key == nil { return previousResolved ? .ignore : .cancel }
            if key == previousKey { return .ignore }
            return .notify
        }()
        return Decision(action: action, observedAt: observedAt, resolved: key == nil, approvalKey: key)
    }
}
