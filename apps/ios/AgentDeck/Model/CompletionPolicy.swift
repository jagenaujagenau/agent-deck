import Foundation

/// When "it stopped running" may be announced as "it finished".
///
/// The debounce is asymmetric on purpose: a session going into working or
/// blocked is believed instantly — those notifications are handled by
/// `AttentionPolicy` — but going into "done" needs proof. Runtimes flick
/// through `idle` between tool calls, and announcing every flicker would teach
/// the person to ignore the one announcement that matters. So running→idle
/// arms a short clock, anything other than idle disarms it, and only a
/// completion that survives the whole window is real.
///
/// Pure by design. The app has no test target today, so nothing exercises this
/// in CI — but keeping the decision free of timers, notification centers and
/// stores means a test target can pick it up whole the day one exists.
enum CompletionPolicy {
    /// How long running→idle must hold before it counts as a completion.
    static let debounce: TimeInterval = 1.0

    enum Step: Equatable {
        /// running→idle was just observed: start the clock.
        case arm
        /// The session is doing something other than sitting idle: any pending
        /// completion was a flicker, not a finish.
        case disarm
        /// Still idle, no news. An armed clock keeps running; nothing arms.
        case hold
    }

    /// What one observed state change means for the completion clock.
    static func step(previous: String?, current: String) -> Step {
        if current != "idle" { return .disarm }
        return previous == "running" ? .arm : .hold
    }

    /// Whether a completion that survived its window may actually be announced.
    /// A finish someone has already seen — or is looking at right now — is not
    /// news.
    static func shouldAnnounce(state: String, seen: Bool, viewingInForeground: Bool) -> Bool {
        state == "idle" && !seen && !viewingInForeground
    }
}
