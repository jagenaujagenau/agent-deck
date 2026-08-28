import Foundation

enum ConnectionPolicy {
    /// Clients never apply a lower snapshot sequence over a higher one.
    static func shouldApply(lastSequence: Int64, incoming: Int64) -> Bool { incoming >= lastSequence }

    /// Doubling backoff, capped. A refused credential is not retried on a timer
    /// at all — see `ConnectionPhase.blocked`.
    static func retryDelay(base: Duration, failedAttempts: Int) -> Duration {
        guard failedAttempts > 0 else { return base }
        var delay = base
        for _ in 0 ..< min(failedAttempts - 1, 8) {
            delay = min(delay * 2, .seconds(16))
        }
        return min(delay, .seconds(16))
    }
}

/// What the connection is doing, in the words the deck header uses.
enum ConnectionPhase: Equatable {
    case connecting
    case connected
    case reconnecting(attempt: Int)
    /// Reachable, but the credential was refused. Retrying cannot fix this, so
    /// nothing retries until the user changes something.
    case blocked(String)
    case backoff(String)

    var isBlocked: Bool { if case .blocked = self { return true }; return false }
}
