import { Option, Schema } from "effect";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { agentIdFor } from "@agent-control-dashboard/agent-adapter";

export type TranscriptUsageRow = {
  agent_id: string;
  project: string;
  runtime: "claude" | "codex";
  model: string;
  tokens: number;
  uncached_input_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  priced: boolean;
  created_at: string;
  dedupeKey: string | null;
};

/**
 * The parts of a Claude transcript line this needs, as a contract.
 *
 * A transcript is another program's file, written by a version of Claude Code
 * that may not be this one. Fields are optional wherever the parser already
 * tolerated their absence, so a line still yields usage when it carries less
 * than expected - what changes is that the shape is stated once here instead of
 * being re-checked at every read.
 */
const ClaudeUsageLine = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.String,
  sessionId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  costUSD: Schema.optional(Schema.Number),
  message: Schema.Struct({
    id: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    usage: Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      cache_creation_input_tokens: Schema.optional(Schema.Number),
      cache_read_input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  }),
});

const decodeClaudeUsageLine = Schema.decodeUnknownOption(ClaudeUsageLine);

/** A token count is only usable when it is a whole number above zero. */
function positive(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseClaudeUsageLine(line: string): TranscriptUsageRow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const decoded = decodeClaudeUsageLine(value);
  if (Option.isNone(decoded)) return undefined;
  const row = decoded.value;
  if (row.type !== "assistant") return undefined;

  const { message } = row;
  const { usage } = message;
  const messageId = message.id ?? null;
  const requestId = row.requestId ?? null;
  const sessionId = row.sessionId ?? "";
  const cwd = row.cwd ?? "";
  const uncachedInputTokens = positive(usage.input_tokens);
  const cacheCreationTokens = positive(usage.cache_creation_input_tokens);
  const cachedInputTokens = positive(usage.cache_read_input_tokens);
  const outputTokens = positive(usage.output_tokens);
  const tokens = uncachedInputTokens + cacheCreationTokens + cachedInputTokens + outputTokens;
  if (tokens === 0 || Number.isNaN(Date.parse(row.timestamp))) return undefined;
  // A cost the transcript states is authoritative; its absence is what `priced`
  // reports, so analytics can say how much of a total it could actually price.
  const priced = row.costUSD !== undefined && Number.isFinite(row.costUSD);
  return {
    agent_id: sessionId
      ? agentIdFor("claude", sessionId)
      : `claude:${messageId ?? requestId ?? row.timestamp}`,
    project: cwd ? basename(cwd) : "claude",
    runtime: "claude",
    model: message.model ?? "unknown",
    tokens,
    uncached_input_tokens: uncachedInputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_creation_tokens: cacheCreationTokens,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    cost_usd: priced ? row.costUSD! : 0,
    priced,
    created_at: row.timestamp,
    dedupeKey: messageId || requestId ? `${messageId ?? ""}:${requestId ?? ""}` : null,
  };
}

async function listJsonl(root: string, sinceMs: number, found: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await listJsonl(path, sinceMs, found);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        if ((await stat(path)).mtimeMs >= sinceMs) found.push(path);
      } catch {
        /* Rotated during scan. */
      }
    }
  }
  return found;
}

export type CodexScanState = {
  model: string;
  sessionId: string;
  project: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
};

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    project: "codex",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * The parts of a Codex rollout line this needs.
 *
 * Codex writes several kinds of line into one file and this reads three of
 * them, so every field below the discriminator is optional: a line is decoded
 * first and interpreted second, rather than being probed key by key.
 */
const CodexLine = Schema.Struct({
  type: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  payload: Schema.Struct({
    type: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    forked_from_id: Schema.optional(Schema.String),
    // `source` is a plain origin label on most lines and a provenance object
    // when a session was spawned from another. It is left unconstrained here
    // and decoded below at the one place its shape decides anything.
    source: Schema.optional(Schema.Unknown),
    info: Schema.optional(
      Schema.Struct({
        last_token_usage: Schema.optional(
          Schema.Struct({
            input_tokens: Schema.optional(Schema.Number),
            cached_input_tokens: Schema.optional(Schema.Number),
            cache_write_input_tokens: Schema.optional(Schema.Number),
            output_tokens: Schema.optional(Schema.Number),
            reasoning_output_tokens: Schema.optional(Schema.Number),
          }),
        ),
      }),
    ),
  }),
});

const decodeCodexLine = Schema.decodeUnknownOption(CodexLine);

type CodexPayload = Schema.Schema.Type<typeof CodexLine>["payload"];

/**
 * Whether this session is a fork of another.
 *
 * A fork replays its parent's usage into its own file, so counting it again
 * would double every token the parent already reported.
 */
const ForkProvenance = Schema.Struct({
  subagent: Schema.Struct({
    thread_spawn: Schema.Struct({ parent_thread_id: Schema.String }),
  }),
});

const asForkProvenance = Schema.decodeUnknownOption(ForkProvenance);

function isForked(payload: CodexPayload) {
  if (payload.forked_from_id !== undefined) return true;
  return Option.isSome(asForkProvenance(payload.source));
}

export function parseCodexUsageLine(
  line: string,
  state: CodexScanState,
): TranscriptUsageRow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const decoded = decodeCodexLine(value);
  if (Option.isNone(decoded)) return undefined;
  const row = decoded.value;
  const body = row.payload;

  if (row.type === "session_meta") {
    if (state.sawSessionMeta) return undefined;
    state.sawSessionMeta = true;
    const id = body.id ?? body.session_id;
    if (id !== undefined) state.sessionId = id;
    if (body.cwd !== undefined) state.project = basename(body.cwd);
    const timestamp = row.timestamp === undefined ? Number.NaN : Date.parse(row.timestamp);
    if (Number.isFinite(timestamp) && isForked(body)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestamp;
    }
    return undefined;
  }
  if (row.type === "turn_context") {
    if (body.model !== undefined) state.model = body.model;
    if (body.cwd !== undefined) state.project = basename(body.cwd);
    return undefined;
  }
  const usage = body.info?.last_token_usage;
  if (body.type !== "token_count" || !usage || !state.model || row.timestamp === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(row.timestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  // Codex repeats the same totals on consecutive lines; only a change is new usage.
  const signature = JSON.stringify(usage);
  if (signature === state.lastUsageSignature) return undefined;
  state.lastUsageSignature = signature;
  if (state.suppressingForkCopies) {
    if (timestamp - state.forkCopyAnchorMs < 1_000) {
      state.forkCopyAnchorMs = timestamp;
      return undefined;
    }
    state.suppressingForkCopies = false;
  }
  const input = positive(usage.input_tokens);
  const cached = positive(usage.cached_input_tokens);
  const cacheWrite = positive(usage.cache_write_input_tokens);
  const output = positive(usage.output_tokens);
  const uncached = Math.max(0, input - cached - cacheWrite);
  const reasoning = Math.min(output, positive(usage.reasoning_output_tokens));
  const tokens = uncached + cached + cacheWrite + output;
  if (!tokens) return undefined;
  return {
    agent_id: state.sessionId ? agentIdFor("codex", state.sessionId) : `codex:${row.timestamp}`,
    project: state.project,
    runtime: "codex",
    model: state.model,
    tokens,
    uncached_input_tokens: uncached,
    cached_input_tokens: cached,
    cache_creation_tokens: cacheWrite,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cost_usd: 0,
    priced: false,
    created_at: row.timestamp,
    dedupeKey: null,
  };
}

export async function scanClaudeUsage(
  sinceIso: string,
  root = join(homedir(), ".claude", "projects"),
): Promise<{ rows: TranscriptUsageRow[]; files: number; duplicates: number }> {
  const sinceMs = Date.parse(sinceIso);
  const files = await listJsonl(root, sinceMs);
  const rows: TranscriptUsageRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const path of files) {
    try {
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.includes('"usage"')) continue;
        const row = parseClaudeUsageLine(line);
        if (!row || Date.parse(row.created_at) < sinceMs) continue;
        if (row.dedupeKey && seen.has(row.dedupeKey)) {
          duplicates += 1;
          continue;
        }
        if (row.dedupeKey) seen.add(row.dedupeKey);
        rows.push(row);
      }
    } catch {
      /* A live transcript may rotate while scanning. */
    }
  }
  return { rows, files: files.length, duplicates };
}

export async function scanCodexUsage(
  sinceIso: string,
  root = join(homedir(), ".codex", "sessions"),
): Promise<{ rows: TranscriptUsageRow[]; files: number }> {
  const sinceMs = Date.parse(sinceIso);
  const files = await listJsonl(root, sinceMs);
  const rows: TranscriptUsageRow[] = [];
  for (const path of files) {
    const state = initialCodexScanState();
    try {
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (
          !line.includes('"token_count"') &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        )
          continue;
        const row = parseCodexUsageLine(line, state);
        if (row && Date.parse(row.created_at) >= sinceMs) rows.push(row);
      }
    } catch {
      /* A live rollout may rotate while scanning. */
    }
  }
  return { rows, files: files.length };
}
