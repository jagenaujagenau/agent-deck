import Foundation
import UIKit
import UserNotifications

/// Posts each concrete approval or question once, and takes it back when it is
/// answered. Mirrored from `apps/android/mobile/.../ApprovalNotifier.kt`.
///
/// **Local, not push, and that is a real limit.** iOS suspends a backgrounded
/// app and tears its socket down, so this can only alert while the app is
/// running or during a background refresh iOS chooses to grant. An approval
/// that opens while the phone is in a pocket may not be announced until the app
/// is next opened. Doing that properly needs APNs, which needs the bridge to
/// hold device tokens and send pushes — server work this app cannot do alone.
/// What is here is worth having anyway: the alert is actionable from the lock
/// screen, and the deck is frequently the thing already open when an approval
/// lands.
@MainActor
final class ApprovalNotifier: NSObject {
    static let shared = ApprovalNotifier()

    private let category = "agent.approval"
    private let defaults = UserDefaults.standard
    private var authorized = false

    /// Approve and Reject on the banner itself. The whole value of being told
    /// about an approval on a lock screen is answering it there.
    func register() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: category,
                actions: [
                    UNNotificationAction(identifier: "approve", title: "Approve", options: [.authenticationRequired]),
                    UNNotificationAction(identifier: "reject", title: "Reject", options: [.authenticationRequired, .destructive]),
                ],
                intentIdentifiers: [],
                options: []
            )
        ])
        Task {
            authorized = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        }
    }

    /// Decides every session against what was last said about it, and posts or
    /// withdraws accordingly. Cheap enough to run on every snapshot: a session
    /// whose observed timestamp has not moved decides `.ignore` without work.
    func reconcile(agents: [Agent]) {
        guard authorized else { return }
        for agent in agents {
            let observedKey = "notify.observed.\(agent.id)"
            let resolvedKey = "notify.resolved.\(agent.id)"
            let postedKey = "notify.posted.\(agent.id)"
            let decision = AttentionPolicy.decide(
                agent: agent,
                previousAt: defaults.string(forKey: observedKey),
                previousResolved: defaults.bool(forKey: resolvedKey),
                previousKey: defaults.string(forKey: postedKey)
            )
            if decision.action == .ignore, decision.observedAt == defaults.string(forKey: observedKey) { continue }
            // Written before posting, so a second reconcile racing this one
            // cannot announce the same approval twice.
            defaults.set(decision.observedAt, forKey: observedKey)
            defaults.set(decision.resolved, forKey: resolvedKey)
            if let key = decision.approvalKey { defaults.set(key, forKey: postedKey) }

            switch decision.action {
            case .cancel: withdraw(agentId: agent.id)
            case .notify: post(agent: agent, approvalKey: decision.approvalKey ?? agent.id)
            case .ignore: break
            }
        }
    }

    func withdraw(agentId: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [agentId])
        center.removePendingNotificationRequests(withIdentifiers: [agentId])
    }

    // MARK: - Completions

    /// "Finished" is the only other thing worth interrupting anyone for, and
    /// `CompletionPolicy` has already decided it is genuine by the time this is
    /// called. Its own identifier, so it never replaces or is replaced by an
    /// approval banner; the shared thread keeps the session's notifications
    /// stacked together.
    func postCompletion(agent: Agent) {
        guard authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(agent.name) finished"
        content.body = [agent.project, agent.task].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        content.sound = .default
        content.userInfo = ["agentId": agent.id]
        content.threadIdentifier = agent.id
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: completionIdentifier(agent.id), content: content, trigger: nil)
        )
    }

    /// Taken back when the session is opened or runs again: a "finished" banner
    /// outliving either is stale news.
    func withdrawCompletion(agentId: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [completionIdentifier(agentId)])
        center.removePendingNotificationRequests(withIdentifiers: [completionIdentifier(agentId)])
    }

    private func completionIdentifier(_ agentId: String) -> String { "\(agentId):done" }

    private func post(agent: Agent, approvalKey: String) {
        let approval = agent.pendingApproval
        let content = UNMutableNotificationContent()
        content.title = approval != nil ? "\(agent.name) needs approval" : "\(agent.name) has a question"
        content.body = approval?.detail ?? agent.pendingQuestion?.question ?? agent.task
        content.sound = .default
        content.userInfo = ["agentId": agent.id, "approvalKey": approvalKey]
        // Only an answerable approval gets the buttons. A question's own preset
        // options are the answer, and they do not fit on a banner.
        if approval != nil { content.categoryIdentifier = category }
        // One notification per session, replaced in place: a session that asks
        // twice should update its banner, not stack a second one behind it.
        content.threadIdentifier = agent.id
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: agent.id, content: content, trigger: nil)
        )
    }
}

extension ApprovalNotifier: UNUserNotificationCenterDelegate {
    /// Shown even with the deck open. The deck is a long list and the session
    /// that just asked may be well off screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let agentId = info["agentId"] as? String else { return }
        let action = response.actionIdentifier
        if action == "approve" || action == "reject" {
            await Self.send(action: action, agentId: agentId)
            return
        }
        guard action == UNNotificationDefaultActionIdentifier else { return }
        // Routed through the app's own URL scheme rather than a second path
        // into the navigation stack, so a tapped notification and a tapped link
        // land the same way.
        guard let encoded = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "agentdeck://agent/\(encoded)") else { return }
        await MainActor.run { UIApplication.shared.open(url) }
    }

    /// Answering from the banner cannot borrow the store's client — the app may
    /// not have a live one — so it builds its own from the stored credential.
    private static func send(action: String, agentId: String) async {
        let connection = ConnectionStore.load()
        guard connection.isConfigured else { return }
        let client = BridgeClient(baseURL: connection.baseURL, token: ConnectionStore.token(for: connection.baseURL))
        try? await client.control(agentId: agentId, action: action)
    }
}
