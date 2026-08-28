import Foundation

/// When each session was last actually looked at.
///
/// The local marks live in `UserDefaults`, the way `ArchivePolicy`'s do: the
/// mark is the newest activity timestamp that was on screen while the session
/// view was open — only the session view marks it, because the deck list
/// showing a card is not the same as someone having read it, and a machine
/// refresh is nobody looking at anything.
///
/// Seen is no longer only this phone's, though. The bridge carries a
/// `viewedAt` on each agent — the last moment a person looked at it on any
/// surface — so a session read on the watch counts here too. The local mark
/// still exists because it is instant: the POST that publishes a view is
/// fire-and-forget and its round trip must never be what clears a badge.
enum SeenPolicy {
    private static let key = "seen_agents"

    static func load(from defaults: UserDefaults = .standard) -> [String: String] {
        defaults.dictionary(forKey: key) as? [String: String] ?? [:]
    }

    static func save(_ marks: [String: String], to defaults: UserDefaults = .standard) {
        defaults.set(marks, forKey: key)
    }

    /// The newest thing that has happened to this session: its heartbeat or its
    /// newest event, whichever is later. ISO-8601 strings, compared as strings,
    /// the way the rest of the app already compares `createdAt`.
    static func activityAt(_ agent: Agent) -> String {
        max(agent.lastSeenAt, agent.events.map(\.createdAt).max() ?? "")
    }

    /// Whether this session has been looked at since it last did anything —
    /// on this phone (the local mark) or anywhere (the bridge's `viewedAt`).
    /// Either mark loses to newer activity: work done after the last look
    /// re-badges, no matter which surface looked. A session never opened
    /// anywhere has never been seen — which is exactly what "finished while
    /// you weren't looking" means for a run started elsewhere.
    static func isSeen(_ agent: Agent, marks: [String: String]) -> Bool {
        let mark = max(marks[agent.id] ?? "", agent.viewedAt ?? "")
        guard !mark.isEmpty else { return false }
        return mark >= activityAt(agent)
    }
}
