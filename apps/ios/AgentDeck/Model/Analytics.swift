import Foundation

/// `/bridge/v1/analytics`, mirrored from `apps/android/shared/.../BridgeModels.kt`.
///
/// Read through the same tolerant helper the rest of the wire uses: the bridge
/// omits `limits` on a runtime that reports no windows, and `project` on an
/// unfiltered read, and neither absence is an error.
private extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, or fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    func optional<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

/// How far back the usage screen looks, and how the bridge buckets it.
enum AnalyticsRange: String, CaseIterable, Identifiable {
    case day, week, month, quarter, year

    var id: String { rawValue }

    var label: String {
        switch self {
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        case .quarter: "Quarter"
        case .year: "Year"
        }
    }

    var days: Int {
        switch self {
        case .day: 1
        case .week: 7
        case .month: 30
        case .quarter: 90
        case .year: 365
        }
    }

    /// What the trend's bars each stand for, which the bridge decides from the
    /// range rather than being asked.
    var bucketLabel: String {
        switch self {
        case .year: "Monthly"
        case .quarter: "Weekly"
        default: "Daily"
        }
    }
}

struct TokenFacets: Decodable, Equatable {
    var uncachedInput: Int64 = 0
    var cachedInput: Int64 = 0
    var cacheCreation: Int64 = 0
    var output: Int64 = 0
    var reasoning: Int64 = 0

    init() {}

    private enum CodingKeys: String, CodingKey { case uncachedInput, cachedInput, cacheCreation, output, reasoning }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        uncachedInput = container.value(.uncachedInput, or: 0)
        cachedInput = container.value(.cachedInput, or: 0)
        cacheCreation = container.value(.cacheCreation, or: 0)
        output = container.value(.output, or: 0)
        reasoning = container.value(.reasoning, or: 0)
    }

    /// Everything the pricing table actually recognised.
    var covered: Int64 { uncachedInput + cachedInput + cacheCreation + output }
}

struct AnalyticsSummary: Decodable, Equatable {
    var tokens: Int64 = 0
    var costUsd: Double = 0
    var events = 0
    var sessions = 0
    var activeDays = 0
    var unpricedTokens: Int64 = 0
    var costCoveragePercent: Double = 100
    var tokenFacets = TokenFacets()

    private enum CodingKeys: String, CodingKey {
        case tokens, costUsd, events, sessions, activeDays, unpricedTokens, costCoveragePercent, tokenFacets
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tokens = container.value(.tokens, or: 0)
        costUsd = container.value(.costUsd, or: 0)
        events = container.value(.events, or: 0)
        sessions = container.value(.sessions, or: 0)
        activeDays = container.value(.activeDays, or: 0)
        unpricedTokens = container.value(.unpricedTokens, or: 0)
        costCoveragePercent = container.value(.costCoveragePercent, or: 100)
        tokenFacets = container.value(.tokenFacets, or: TokenFacets())
    }
}

struct AnalyticsPoint: Decodable, Equatable, Identifiable {
    var bucket: String
    var tokens: Int64
    var costUsd: Double
    var events: Int

    var id: String { bucket }

    private enum CodingKeys: String, CodingKey { case bucket, tokens, costUsd, events }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bucket = container.value(.bucket, or: "")
        tokens = container.value(.tokens, or: 0)
        costUsd = container.value(.costUsd, or: 0)
        events = container.value(.events, or: 0)
    }
}

struct ActivityDay: Decodable, Equatable, Identifiable {
    var date: String
    var count: Int
    var tokens: Int64
    var costUsd: Double

    var id: String { date }

    private enum CodingKeys: String, CodingKey { case date, count, tokens, costUsd }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = container.value(.date, or: "")
        count = container.value(.count, or: 0)
        tokens = container.value(.tokens, or: 0)
        costUsd = container.value(.costUsd, or: 0)
    }
}

struct ProjectUsage: Decodable, Equatable, Identifiable {
    var project: String
    var tokens: Int64
    var costUsd: Double
    var events: Int
    var sessions: Int

    var id: String { project }

    private enum CodingKeys: String, CodingKey { case project, tokens, costUsd, events, sessions }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        project = container.value(.project, or: "")
        tokens = container.value(.tokens, or: 0)
        costUsd = container.value(.costUsd, or: 0)
        events = container.value(.events, or: 0)
        sessions = container.value(.sessions, or: 0)
    }
}

struct RuntimeUsage: Decodable, Equatable, Identifiable {
    var runtime: String
    var tokens: Int64
    var costUsd: Double
    var events: Int

    var id: String { runtime }

    private enum CodingKeys: String, CodingKey { case runtime, tokens, costUsd, events }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runtime = container.value(.runtime, or: "")
        tokens = container.value(.tokens, or: 0)
        costUsd = container.value(.costUsd, or: 0)
        events = container.value(.events, or: 0)
    }
}

struct AnalyticsFilters: Decodable, Equatable {
    var projects: [String] = []

    init() {}

    private enum CodingKeys: String, CodingKey { case projects }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projects = container.value(.projects, or: [])
    }
}

struct AnalyticsSnapshot: Decodable, Equatable {
    var range: String
    var project: String?
    var timeZone: String
    var generatedAt: String
    var summary: AnalyticsSummary
    var series: [AnalyticsPoint]
    var heatmap: [ActivityDay]
    var projects: [ProjectUsage]
    var runtimes: [RuntimeUsage]
    var limits: [RateLimitWindow]
    var filters: AnalyticsFilters

    private enum CodingKeys: String, CodingKey {
        case range, project, timeZone, generatedAt, summary, series, heatmap, projects, runtimes, limits, filters
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        range = container.value(.range, or: "month")
        project = container.optional(.project)
        timeZone = container.value(.timeZone, or: "UTC")
        generatedAt = container.value(.generatedAt, or: "")
        summary = try container.decode(AnalyticsSummary.self, forKey: .summary)
        series = container.value(.series, or: [])
        heatmap = container.value(.heatmap, or: [])
        projects = container.value(.projects, or: [])
        runtimes = container.value(.runtimes, or: [])
        limits = container.value(.limits, or: [])
        filters = container.value(.filters, or: AnalyticsFilters())
    }
}

/// Loading is not the same as empty, and a failure that still has last read's
/// numbers is not the same as one that has nothing to show.
enum AnalyticsState: Equatable {
    case loading
    case ready(AnalyticsSnapshot)
    case failed(message: String, previous: AnalyticsSnapshot?)

    var data: AnalyticsSnapshot? {
        switch self {
        case .loading: nil
        case .ready(let snapshot): snapshot
        case .failed(_, let previous): previous
        }
    }
}

/// A `/` command a runtime advertises for this session.
struct SlashCommand: Decodable, Equatable, Identifiable {
    var name: String
    var description: String?
    var source: String

    var id: String { name }

    private enum CodingKeys: String, CodingKey { case name, description, source }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        description = container.optional(.description)
        source = container.value(.source, or: "user")
    }
}

struct SlashCommandCatalog: Decodable {
    var commands: [SlashCommand] = []

    private enum CodingKeys: String, CodingKey { case commands }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        commands = container.value(.commands, or: [])
    }
}
