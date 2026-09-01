import Foundation

/// Where a conversation crosses from one day into the next.
///
/// A session open since yesterday reads as one unbroken run of messages, and
/// the timestamps only say the hour — so "09:14" under "23:47" looks like a
/// reply four minutes later rather than ten hours.
///
/// The answers are pinned to `packages/bridge-client/fixtures/attention-parity.json`
/// alongside the Kotlin implementation, because a separator drawn on one phone
/// and not the other is the kind of difference nobody notices until the two
/// are held side by side.
enum ConversationDays {
    private static func formatter(_ format: String, _ zone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        // The labels are the product's own words, not the reader's locale:
        // Kotlin formats "3 August" from a fixed pattern, and a device set to
        // another locale must not quietly render a different string than the
        // corpus says.
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = format
        return formatter
    }

    private static func day(of iso: String, zone: TimeZone) -> DateComponents? {
        guard let date = Timestamps.parse(iso) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateComponents([.year, .month, .day], from: date)
    }

    /// The label to draw above this message, or nothing when it belongs to the
    /// same day as the one before it.
    ///
    /// The first message always carries one: a conversation opening with no
    /// date leaves the reader guessing whether it started today.
    static func separatorBefore(
        previous: String?,
        current: String,
        today: Date = Date(),
        zone: TimeZone = .current
    ) -> String? {
        guard let date = Timestamps.parse(current),
              let currentDay = day(of: current, zone: zone) else { return nil }
        if let previous, day(of: previous, zone: zone) == currentDay { return nil }
        return label(date, today: today, zone: zone)
    }

    /// How a person names a day: by its distance from now, then by its date.
    static func label(_ date: Date, today: Date = Date(), zone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: today),
            to: calendar.startOfDay(for: date)
        ).day
        if days == 0 { return "Today" }
        if days == -1 { return "Yesterday" }
        // The year only earns its space once it is no longer the obvious one.
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: today)
        return formatter(sameYear ? "d MMMM" : "d MMMM yyyy", zone).string(from: date)
    }
}
