import type { TranscriptUsageRow } from "../transcriptUsage.ts";

/**
 * The analytics roll-up, as a pure function.
 *
 * Every input it needs is passed in, so the aggregation can be tested against
 * fixed rows instead of a live database and a scan of the user's transcripts.
 */

export interface UsageRow {
  agent_id: string;
  project: string;
  runtime: string;
  tokens: number;
  cost_usd: number;
  created_at: string;
  priced?: boolean;
}

export interface ActivityRow {
  agent_id: string;
  project: string;
  runtime: string;
  kind: string;
  created_at: string;
}

export interface RateLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  account?: string;
}

export interface AnalyticsAgent {
  id: string;
  project: string;
  runtime: string;
  state: string;
  lastSeenAt: string;
  rateLimits?: ReadonlyArray<RateLimitWindow>;
}

export interface AnalyticsInput {
  range: string;
  project?: string;
  timeZone: string;
  generatedAt: string;
  ledgerUsage: ReadonlyArray<UsageRow>;
  activityRows: ReadonlyArray<ActivityRow>;
  agents: ReadonlyArray<AnalyticsAgent>;
  transcript: {
    rows: ReadonlyArray<TranscriptUsageRow>;
    claudeFiles: number;
    codexFiles: number;
    duplicates: number;
  };
}

export const RANGE_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};

export const rangeCutoff = (range: string, from: number) => {
  const selected = range in RANGE_DAYS ? range : "month";
  return {
    selected,
    cutoff: new Date(from - RANGE_DAYS[selected]! * 86_400_000).toISOString(),
  };
};

export const buildAnalytics = (input: AnalyticsInput) => {
  const { selected: selectedRange } = rangeCutoff(input.range, Date.parse(input.generatedAt));
  const { project } = input;
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));

  // A session whose usage we can read from its transcript is counted from the
  // transcript only — the heartbeat ledger for that session would double it.
  const trackedTranscriptRows = input.transcript.rows.flatMap((row) => {
    const agent = byId.get(row.agent_id);
    return agent?.runtime === row.runtime ? [{ ...row, project: agent.project }] : [];
  });
  const transcriptBacked = new Set(trackedTranscriptRows.map((row) => row.agent_id));
  const usage: Array<UsageRow> = [
    ...input.ledgerUsage.filter((row) => !transcriptBacked.has(row.agent_id)),
    ...(trackedTranscriptRows as unknown as Array<UsageRow>),
  ]
    .filter((row) => !project || row.project === project)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));

  const activity = input.activityRows.filter((row) => !project || row.project === project);
  const sessionIds = new Set([
    ...usage.map((row) => row.agent_id),
    ...activity.map((row) => row.agent_id),
  ]);

  let timeZone = input.timeZone;
  let dayFormatter: Intl.DateTimeFormat;
  const formatterFor = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  try {
    dayFormatter = formatterFor(timeZone);
  } catch {
    // An unknown zone from a device must not fail the whole request.
    timeZone = "UTC";
    dayFormatter = formatterFor(timeZone);
  }
  const dayFor = (timestamp: string) => dayFormatter.format(new Date(timestamp));
  const bucketFor = (timestamp: string) => {
    const localDay = dayFor(timestamp);
    const date = new Date(`${localDay}T00:00:00.000Z`);
    if (selectedRange === "day") return `${timestamp.slice(0, 13)}:00:00.000Z`;
    if (selectedRange === "year") return `${localDay.slice(0, 7)}-01T00:00:00.000Z`;
    if (selectedRange === "quarter") {
      const day = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - day);
      return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
    }
    return `${localDay}T00:00:00.000Z`;
  };

  const series = new Map<
    string,
    { bucket: string; tokens: number; costUsd: number; events: number }
  >();
  const heatmap = new Map<
    string,
    { date: string; count: number; tokens: number; costUsd: number }
  >();
  const projectMap = new Map<
    string,
    { project: string; tokens: number; costUsd: number; events: number; sessions: Set<string> }
  >();
  const runtimeMap = new Map<
    string,
    { runtime: string; tokens: number; costUsd: number; events: number }
  >();
  const ensureSeries = (bucket: string) =>
    series.get(bucket) ?? { bucket, tokens: 0, costUsd: 0, events: 0 };

  for (const row of usage) {
    const bucket = bucketFor(row.created_at);
    const point = ensureSeries(bucket);
    point.tokens += row.tokens;
    point.costUsd += row.cost_usd;
    series.set(bucket, point);
    const date = dayFor(row.created_at);
    const day = heatmap.get(date) ?? { date, count: 0, tokens: 0, costUsd: 0 };
    day.tokens += row.tokens;
    day.costUsd += row.cost_usd;
    heatmap.set(date, day);
    const item = projectMap.get(row.project) ?? {
      project: row.project,
      tokens: 0,
      costUsd: 0,
      events: 0,
      sessions: new Set<string>(),
    };
    item.tokens += row.tokens;
    item.costUsd += row.cost_usd;
    item.sessions.add(row.agent_id);
    projectMap.set(row.project, item);
    const runtime = runtimeMap.get(row.runtime) ?? {
      runtime: row.runtime,
      tokens: 0,
      costUsd: 0,
      events: 0,
    };
    runtime.tokens += row.tokens;
    runtime.costUsd += row.cost_usd;
    runtimeMap.set(row.runtime, runtime);
  }

  for (const row of activity) {
    const bucket = bucketFor(row.created_at);
    const point = ensureSeries(bucket);
    point.events += 1;
    series.set(bucket, point);
    const date = dayFor(row.created_at);
    const day = heatmap.get(date) ?? { date, count: 0, tokens: 0, costUsd: 0 };
    day.count += 1;
    heatmap.set(date, day);
    const item = projectMap.get(row.project) ?? {
      project: row.project,
      tokens: 0,
      costUsd: 0,
      events: 0,
      sessions: new Set<string>(),
    };
    item.events += 1;
    item.sessions.add(row.agent_id);
    projectMap.set(row.project, item);
    const runtime = runtimeMap.get(row.runtime) ?? {
      runtime: row.runtime,
      tokens: 0,
      costUsd: 0,
      events: 0,
    };
    runtime.events += 1;
    runtimeMap.set(row.runtime, runtime);
  }

  const projects = [
    ...new Set([
      ...projectMap.keys(),
      ...input.agents.filter((agent) => agent.state !== "offline").map((agent) => agent.project),
    ]),
  ].sort();

  // The newest report per account wins: two sessions on one account report the
  // same window, and the stale one would understate it.
  const limits = new Map<string, RateLimitWindow & { runtime: string; updatedAt: string }>();
  for (const agent of input.agents) {
    if (project && agent.project !== project) continue;
    for (const window of agent.rateLimits ?? []) {
      const key = `${agent.runtime}:${window.account ?? "default"}:${window.id}`;
      const previous = limits.get(key);
      if (!previous || agent.lastSeenAt > previous.updatedAt) {
        limits.set(key, { ...window, runtime: agent.runtime, updatedAt: agent.lastSeenAt });
      }
    }
  }

  const unpricedTokens = usage.reduce(
    (sum, row) => sum + ("priced" in row && row.priced === false ? row.tokens : 0),
    0,
  );
  const totalTokens = usage.reduce((sum, row) => sum + row.tokens, 0);

  return {
    range: selectedRange,
    project: project ?? null,
    timeZone,
    generatedAt: input.generatedAt,
    summary: {
      tokens: totalTokens,
      costUsd: usage.reduce((sum, row) => sum + row.cost_usd, 0),
      unpricedTokens,
      costCoveragePercent:
        totalTokens > 0 ? ((totalTokens - unpricedTokens) / totalTokens) * 100 : 100,
      tokenFacets: trackedTranscriptRows.reduce(
        (totals, row) => ({
          uncachedInput: totals.uncachedInput + row.uncached_input_tokens,
          cachedInput: totals.cachedInput + row.cached_input_tokens,
          cacheCreation: totals.cacheCreation + row.cache_creation_tokens,
          output: totals.output + row.output_tokens,
          reasoning: totals.reasoning + row.reasoning_tokens,
        }),
        { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0 },
      ),
      events: activity.length,
      sessions: sessionIds.size,
      activeDays: heatmap.size,
    },
    series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    heatmap: [...heatmap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    projects: [...projectMap.values()]
      .map((item) => ({ ...item, sessions: item.sessions.size }))
      .sort((a, b) => b.tokens - a.tokens),
    runtimes: [...runtimeMap.values()].sort((a, b) => b.tokens - a.tokens),
    limits: [...limits.values()].sort((a, b) => b.usedPercent - a.usedPercent),
    filters: { projects },
    sources: {
      claude: {
        files: input.transcript.claudeFiles,
        trackedRecords: trackedTranscriptRows.filter((row) => row.runtime === "claude").length,
        duplicatesDropped: input.transcript.duplicates,
        mode: "global-transcript-dedup",
      },
      codex: {
        files: input.transcript.codexFiles,
        trackedRecords: trackedTranscriptRows.filter((row) => row.runtime === "codex").length,
        mode: "rollout-delta-fork-suppression",
      },
    },
  };
};
