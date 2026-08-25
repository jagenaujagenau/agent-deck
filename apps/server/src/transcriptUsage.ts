import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

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

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseClaudeUsageLine(line: string): TranscriptUsageRow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.type !== "assistant" || !row.message || typeof row.message !== "object") return undefined;
  const message = row.message as Record<string, unknown>;
  if (!message.usage || typeof message.usage !== "object" || typeof row.timestamp !== "string")
    return undefined;
  const usage = message.usage as Record<string, unknown>;
  const messageId = typeof message.id === "string" ? message.id : null;
  const requestId = typeof row.requestId === "string" ? row.requestId : null;
  const sessionId = typeof row.sessionId === "string" ? row.sessionId : "";
  const cwd = typeof row.cwd === "string" ? row.cwd : "";
  const model = typeof message.model === "string" ? message.model : "unknown";
  const uncachedInputTokens = positive(usage.input_tokens);
  const cacheCreationTokens = positive(usage.cache_creation_input_tokens);
  const cachedInputTokens = positive(usage.cache_read_input_tokens);
  const outputTokens = positive(usage.output_tokens);
  const tokens = uncachedInputTokens + cacheCreationTokens + cachedInputTokens + outputTokens;
  if (tokens === 0 || Number.isNaN(Date.parse(row.timestamp))) return undefined;
  return {
    agent_id: sessionId
      ? `claude-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`
      : `claude:${messageId ?? requestId ?? row.timestamp}`,
    project: cwd ? basename(cwd) : "claude",
    runtime: "claude",
    model,
    tokens,
    uncached_input_tokens: uncachedInputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_creation_tokens: cacheCreationTokens,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    cost_usd: typeof row.costUSD === "number" && Number.isFinite(row.costUSD) ? row.costUSD : 0,
    priced: typeof row.costUSD === "number" && Number.isFinite(row.costUSD),
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

function isForked(payload: Record<string, unknown>) {
  if (typeof payload.forked_from_id === "string") return true;
  const source = payload.source;
  if (!source || typeof source !== "object") return false;
  const subagent = (source as Record<string, unknown>).subagent;
  if (!subagent || typeof subagent !== "object") return false;
  const spawn = (subagent as Record<string, unknown>).thread_spawn;
  return (
    !!spawn &&
    typeof spawn === "object" &&
    typeof (spawn as Record<string, unknown>).parent_thread_id === "string"
  );
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
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  if (row.type === "session_meta") {
    if (state.sawSessionMeta) return undefined;
    state.sawSessionMeta = true;
    const id = body.id ?? body.session_id;
    if (typeof id === "string") state.sessionId = id;
    if (typeof body.cwd === "string") state.project = basename(body.cwd);
    const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(timestamp) && isForked(body)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestamp;
    }
    return undefined;
  }
  if (row.type === "turn_context") {
    if (typeof body.model === "string") state.model = body.model;
    if (typeof body.cwd === "string") state.project = basename(body.cwd);
    return undefined;
  }
  if (body.type !== "token_count" || !body.info || typeof body.info !== "object") return undefined;
  const last = (body.info as Record<string, unknown>).last_token_usage;
  if (!last || typeof last !== "object" || !state.model || typeof row.timestamp !== "string")
    return undefined;
  const timestamp = Date.parse(row.timestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  const usage = last as Record<string, unknown>;
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
    agent_id: state.sessionId
      ? `codex-${createHash("sha256").update(state.sessionId).digest("hex").slice(0, 24)}`
      : `codex:${row.timestamp}`,
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
