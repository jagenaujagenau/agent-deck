import SwiftUI

/// What the deck has spent and how hard it has been working.
///
/// Amber does not appear here except on a rate limit approaching its ceiling —
/// which genuinely is a session about to want a person. Spend is plain text and
/// tokens are blue; a bill is not a request, and colouring it amber would spend
/// the one signal the deck has on something nobody can act on.
struct UsageView: View {
    @Environment(DeckStore.self) private var store

    @State private var range: AnalyticsRange = .month
    @State private var project: String?

    var body: some View {
        Group {
            if let data = store.analytics.data {
                loaded(data)
            } else if case .failed(let message, _) = store.analytics {
                failed(message)
            } else {
                skeleton
            }
        }
        .background(Palette.ink)
        .task(id: "\(range.rawValue):\(project ?? "")") {
            store.loadAnalytics(range: range, project: project)
        }
    }

    private func loaded(_ data: AnalyticsSnapshot) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Usage")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(Palette.text)
                    Text("Agent activity and spend over the past \(range.label.lowercased())")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.muted)
                }

                chips(AnalyticsRange.allCases.map { option in
                    (option.label, range == option, { range = option })
                })

                if !data.filters.projects.isEmpty {
                    chips(
                        [("All projects", project == nil, { project = nil })]
                            + data.filters.projects.map { name in (name, project == name, { project = name }) }
                    )
                }

                UsageSummaryCard(summary: data.summary)
                if !data.limits.isEmpty { RateLimitCard(limits: data.limits) }
                ActivityHeatmapCard(days: data.heatmap, range: range)
                TokenTrendCard(points: data.series, range: range)

                if !data.projects.isEmpty {
                    SectionLabel("BY PROJECT")
                    ForEach(data.projects) { item in
                        ProjectUsageRow(item: item, totalTokens: data.summary.tokens)
                    }
                }
                if !data.runtimes.isEmpty {
                    SectionLabel("BY RUNTIME")
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(data.runtimes) { item in RuntimeUsageCard(item: item) }
                        }
                    }
                }
                // The numbers above are the last good read, not this moment's.
                if case .failed(let message, _) = store.analytics {
                    Text(message)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.amber)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Palette.amber.opacity(0.10)))
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 40)
        }
        .refreshable { store.loadAnalytics(range: range, project: project) }
    }

    private func chips(_ items: [(String, Bool, () -> Void)]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Button(action: item.2) {
                        Text(item.0)
                            .font(.system(size: 13, weight: item.1 ? .semibold : .regular))
                            .foregroundStyle(item.1 ? Palette.ink : Palette.muted)
                            .lineLimit(1)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(item.1 ? Palette.signal : Palette.surfaceRaised))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
    }

    /// A skeleton, not a spinner: the content starts at the top of the screen,
    /// and a centred spinner leaves a header-shaped hole above it.
    private var skeleton: some View {
        VStack(spacing: 12) {
            ForEach(0 ..< 4, id: \.self) { index in
                RoundedRectangle(cornerRadius: 20)
                    .fill(Palette.surfaceRaised)
                    .frame(height: index == 0 ? 130 : 72)
            }
            Spacer()
        }
        .padding(24)
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 28))
                .foregroundStyle(Palette.danger)
            Text("Usage unavailable")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
            Button("Try again") { store.loadAnalytics(range: range, project: project) }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.signal)
                .padding(.top, 4)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct SectionLabel: View {
    var text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .bold))
            .kerning(1)
            .foregroundStyle(Palette.muted)
    }
}

private struct UsageSummaryCard: View {
    var summary: AnalyticsSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Label("PRICED COST")
                    // Plain, not amber: size already makes this the headline,
                    // and it leaves blue as the single accent in the card.
                    Text(money(summary.costUsd))
                        .font(.system(size: 38, weight: .semibold))
                        .foregroundStyle(Palette.text)
                    if summary.costCoveragePercent < 99.9 {
                        Text("\(Int(summary.costCoveragePercent))% token coverage \u{00B7} \(compact(summary.unpricedTokens)) unpriced")
                            .font(.system(size: 11))
                            .foregroundStyle(Palette.muted)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Label("TOKENS")
                    Text(compact(summary.tokens))
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(Palette.blue)
                }
            }
            divider
            HStack {
                metric("Sessions", "\(summary.sessions)")
                Spacer()
                metric("Events", "\(summary.events)")
                Spacer()
                metric("Active days", "\(summary.activeDays)")
            }
            if summary.tokenFacets.covered > 0 {
                divider
                Label("TOKEN MIX")
                HStack {
                    metric("Input", compact(summary.tokenFacets.uncachedInput))
                    Spacer()
                    metric("Cache read", compact(summary.tokenFacets.cachedInput))
                    Spacer()
                    metric("Cache write", compact(summary.tokenFacets.cacheCreation))
                }
                HStack {
                    metric("Output", compact(summary.tokenFacets.output))
                    Spacer()
                    metric("Reasoning*", compact(summary.tokenFacets.reasoning))
                    Spacer()
                    metric("Covered", compact(summary.tokenFacets.covered))
                }
                Text("* Reasoning is included in output totals.")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24).fill(Palette.surfaceRaised))
    }

    private var divider: some View {
        Rectangle().fill(Palette.muted.opacity(0.16)).frame(height: 1)
    }

    private func Label(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .bold))
            .kerning(1.1)
            .foregroundStyle(Palette.muted)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Palette.text)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
        }
    }
}

private struct RateLimitCard: View {
    var limits: [RateLimitWindow]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Rate limits")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.text)
                Spacer()
                Text("Live provider windows")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 18) {
                    ForEach(limits) { limit in ring(limit) }
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24).fill(Palette.surfaceRaised))
    }

    private func ring(_ limit: RateLimitWindow) -> some View {
        let used = min(max(limit.usedPercent / 100, 0), 1)
        // Amber earns its place here: a window near its ceiling is a session
        // about to stop and want a person.
        let color: Color = used >= 0.9 ? Palette.danger : used >= 0.7 ? Palette.amber : Palette.signal
        return VStack(spacing: 6) {
            ZStack {
                Circle().stroke(Palette.line, lineWidth: 6)
                Circle()
                    .trim(from: 0, to: used)
                    .stroke(color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(limit.usedPercent))%")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.text)
            }
            .frame(width: 68, height: 68)
            Text(limit.label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.text)
                .lineLimit(1)
            Text(limit.runtime?.capitalized ?? limit.account ?? "Provider")
                .font(.system(size: 10))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
        }
        .frame(width: 82)
    }
}

private struct ActivityHeatmapCard: View {
    var days: [ActivityDay]
    var range: AnalyticsRange

    @State private var selected: ActivityDay?

    var body: some View {
        let peak = max(days.map(\.count).max() ?? 0, 1)
        let weeks = calendarWeeks
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Activity")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.text)
                Spacer()
                Text(plural(days.reduce(0) { $0 + $1.count }, "event"))
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 4) {
                    ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                        VStack(spacing: 4) {
                            ForEach(week, id: \.self) { date in
                                cell(date, peak: peak)
                            }
                        }
                    }
                }
                // The current week is the one worth seeing first, and it is at
                // the far end of the row.
                .flipsForRightToLeftLayoutDirection(false)
            }
            .defaultScrollAnchor(.trailing)
            if let selected {
                Text("\(selected.date)  \u{00B7}  \(selected.count) events  \u{00B7}  \(compact(selected.tokens)) tokens  \u{00B7}  \(money(selected.costUsd))")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
            }
            HStack(spacing: 5) {
                Text("Less").font(.system(size: 10)).foregroundStyle(Palette.muted)
                ForEach([0.12, 0.35, 0.55, 0.75, 1.0], id: \.self) { alpha in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(alpha == 0.12 ? Palette.muted.opacity(alpha) : Palette.signal.opacity(alpha))
                        .frame(width: 10, height: 10)
                }
                Text("More").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24).fill(Palette.surfaceRaised))
    }

    private func cell(_ date: String, peak: Int) -> some View {
        let day = days.first { $0.date == date }
        let level = day.map { $0.count == 0 ? 0 : min(max(Double($0.count) / Double(peak), 0.2), 1) } ?? 0
        return RoundedRectangle(cornerRadius: 3)
            .fill(level == 0 ? Palette.muted.opacity(0.12) : Palette.signal.opacity(0.25 + level * 0.75))
            .frame(width: 13, height: 13)
            .onTapGesture { if let day { selected = day } }
    }

    /// The window as calendar weeks, Sunday first, so the grid's rows are
    /// weekdays rather than an arbitrary offset from today.
    private var calendarWeeks: [[String]] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let today = calendar.startOfDay(for: Date())
        guard let first = calendar.date(byAdding: .day, value: -(range.days - 1), to: today) else { return [] }
        let startWeekday = calendar.component(.weekday, from: first)
        guard let start = calendar.date(byAdding: .day, value: -(startWeekday - 1), to: first) else { return [] }
        let trailing = 7 - calendar.component(.weekday, from: today)
        guard let end = calendar.date(byAdding: .day, value: trailing, to: today) else { return [] }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = calendar.timeZone

        var weeks: [[String]] = []
        var week: [String] = []
        var cursor = start
        while cursor <= end {
            week.append(formatter.string(from: cursor))
            if week.count == 7 {
                weeks.append(week)
                week = []
            }
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        if !week.isEmpty { weeks.append(week) }
        return weeks
    }
}

private struct TokenTrendCard: View {
    var points: [AnalyticsPoint]
    var range: AnalyticsRange

    var body: some View {
        let peak = max(points.map(\.tokens).max() ?? 0, 1)
        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Token trend")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.text)
                Spacer()
                Text(range.bucketLabel)
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.muted)
            }
            if points.isEmpty {
                Text("Usage will appear after agents report new token deltas.")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.muted)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .bottom, spacing: 6) {
                        ForEach(points) { point in
                            UnevenRoundedRectangle(cornerRadii: .init(topLeading: 4, topTrailing: 4))
                                .fill(Palette.blue.opacity(0.82))
                                .frame(width: 14, height: max(4, (Double(point.tokens) / Double(peak) * 88).rounded(.up)))
                        }
                    }
                    .frame(height: 100, alignment: .bottom)
                }
                .defaultScrollAnchor(.trailing)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24).fill(Palette.surfaceRaised))
    }
}

private struct ProjectUsageRow: View {
    var item: ProjectUsage
    var totalTokens: Int64

    var body: some View {
        let share = totalTokens <= 0 ? 0 : Double(item.tokens) / Double(totalTokens)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.project)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Text("\(plural(item.sessions, "session")) \u{00B7} \(plural(item.events, "event"))")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(compact(item.tokens))
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.blue)
                    Text(money(item.costUsd))
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                }
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.muted.opacity(0.12))
                    Capsule().fill(Palette.signal).frame(width: geometry.size.width * min(max(share, 0), 1))
                }
            }
            .frame(height: 4)
        }
        .padding(.vertical, 4)
    }
}

private struct RuntimeUsageCard: View {
    var item: RuntimeUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.runtime.capitalized)
                .font(.system(size: 12))
                .foregroundStyle(Palette.muted)
            Text(compact(item.tokens))
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Palette.blue)
            Text("\(money(item.costUsd)) \u{00B7} \(plural(item.events, "event"))")
                .font(.system(size: 11))
                .foregroundStyle(Palette.muted)
        }
        .padding(14)
        .frame(width: 150, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18).fill(Palette.surface))
    }
}

/// "1 session", not "1 sessions".
func plural(_ count: Int, _ singular: String) -> String {
    "\(count) \(count == 1 ? singular : singular + "s")"
}

func compact(_ value: Int64) -> String {
    func trim(_ number: Double, _ suffix: String) -> String {
        String(format: "%.1f", number).replacingOccurrences(of: ".0", with: "") + suffix
    }
    if value >= 1_000_000_000 { return trim(Double(value) / 1_000_000_000, "B") }
    if value >= 1_000_000 { return trim(Double(value) / 1_000_000, "M") }
    if value >= 1_000 { return trim(Double(value) / 1_000, "K") }
    return "\(value)"
}

/// A cost too small to write in cents is worth saying is small, not rounding to
/// zero — "$0.00" for real spend reads as a bug.
func money(_ value: Double) -> String {
    if value > 0, value < 0.01 { return "<$0.01" }
    return String(format: "$%.2f", value)
}
