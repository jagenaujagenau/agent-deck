import Foundation

/// The bridge speaks ISO-8601 with fractional seconds; some adapters drop them.
/// One parser, tolerant of both, because two would disagree eventually.
enum Timestamps {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String) -> Date? {
        withFraction.date(from: value) ?? plain.date(from: value)
    }

    /// The card's age line: "now", "4m ago", "2h ago", "3d ago".
    static func freshness(_ value: String, now: Date = Date()) -> String {
        guard let date = parse(value) else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<45: return "now"
        case ..<3_600: return "\(seconds / 60)m ago"
        case ..<86_400: return "\(seconds / 3_600)h ago"
        default: return "\(seconds / 86_400)d ago"
        }
    }

    /// How long a pending approval has left before the bridge expires it.
    static func remaining(until value: String, now: Date = Date()) -> String? {
        guard let date = parse(value) else { return nil }
        let seconds = Int(date.timeIntervalSince(now))
        if seconds <= 0 { return nil }
        if seconds < 60 { return "\(seconds)s left" }
        return "\(seconds / 60)m left"
    }
}
