import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalRuntimeEvent } from "./runtime-events";

/**
 * The client every adapter talks to the bridge through, and the wire types it
 * carries.
 *
 * Separate from the package barrel because the barrel also re-exports the
 * managed Claude runtime, which imports the Claude Agent SDK at module scope.
 * An adapter that only needs to post a heartbeat was pulling that entire SDK in
 * behind it - harmless when the source is loaded from a checkout, and 1.5 MB of
 * an unrelated vendor's code once anything bundles it.
 */

export type AgentState = "idle" | "running" | "waiting" | "paused" | "error" | "offline";
// `user` carries a message the person sent, which the bridge renders on the conversation side.
export type EventKind = "thought" | "tool" | "output" | "warning" | "error" | "question" | "user";
export type ControlAction =
  | "pause"
  | "resume"
  | "stop"
  | "approve"
  | "reject"
  | "prompt"
  | "steer"
  | "follow_up";

export type AgentHeartbeat = {
  id: string;
  name: string;
  project: string;
  model: string;
  runtime?: string;
  runtimeProtocol?: "canonical-v1";
  state: AgentState;
  task: string;
  objective?: string;
  progress?: number;
  /** Current context pressure shown on live cards. */
  tokens?: number;
  /** Monotonic processed usage used by historical analytics. */
  processedTokens?: number;
  costUsd?: number;
  capabilities?: ControlAction[];
  rateLimits?: RateLimitWindow[];
  pendingApproval?: PendingApproval;
};

export type PendingApproval = {
  id: string;
  tool: string;
  detail: string;
  createdAt: string;
  expiresAt: string;
};
export type RateLimitWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  account?: string;
};
export type AgentEventInput = {
  kind: EventKind;
  summary: string;
  detail?: string;
  id?: string;
  tool?: string;
  path?: string;
  command?: string;
  diff?: string;
  options?: string[];
  /** Which subagent produced this, where a subagent did. */
  subagentId?: string;
  subagentType?: string;
};

export type RemoteCommand = {
  id: string;
  action: ControlAction;
  value?: string;
  createdAt?: string;
};

export type AdapterClientOptions = {
  baseUrl?: string;
  token?: string | (() => string);
  timeoutMs?: number;
};

const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "agent-deck", "runtime-token");

export function runtimeToken(): string {
  if (process.env.AGENT_DECK_TOKEN) return process.env.AGENT_DECK_TOKEN;
  try {
    return readFileSync(process.env.AGENT_DECK_TOKEN_FILE ?? DEFAULT_TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Devices resolve a question with `{ "<question>": "<answer>" }` — the shape the hosted Claude
 * adapter consumes. A runtime that just needs the choice wants the answer alone.
 */
export function answerText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.values(value as Record<string, unknown>).filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (entries.length === 1) return entries[0];
  }
  return value === undefined || value === null ? undefined : JSON.stringify(value);
}

export class AgentDeckClient {
  readonly baseUrl: string;
  private readonly token: string | (() => string);
  private readonly timeoutMs: number;

  constructor(options: AdapterClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.AGENT_DECK_URL ??
      "http://127.0.0.1:3000"
    ).replace(/\/$/, "");
    this.token = options.token ?? runtimeToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    const token = typeof this.token === "function" ? this.token() : this.token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${this.baseUrl}/bridge/v1${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Bridge ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  heartbeat(agent: AgentHeartbeat) {
    return this.request("/agents/heartbeat", {
      method: "POST",
      body: JSON.stringify({ ...agent, tokens: agent.tokens ?? 0, costUsd: agent.costUsd ?? 0 }),
    });
  }

  event(agentId: string, event: AgentEventInput) {
    return this.request(`/agents/${encodeURIComponent(agentId)}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  runtimeEvent(event: CanonicalRuntimeEvent) {
    return this.request(`/agents/${encodeURIComponent(event.agentId)}/runtime-events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  async commands(agentId: string): Promise<RemoteCommand[]> {
    const result = await this.request<{ commands: RemoteCommand[] }>(
      `/agents/${encodeURIComponent(agentId)}/commands`,
    );
    return result.commands;
  }

  acknowledge(agentId: string, commandId: string) {
    return this.request(
      `/agents/${encodeURIComponent(agentId)}/commands/${encodeURIComponent(commandId)}/ack`,
      { method: "POST" },
    );
  }

  requestStatus(agentId: string, requestId: string) {
    return this.request<{ status: string; value?: unknown }>(
      `/agents/${encodeURIComponent(agentId)}/requests/${encodeURIComponent(requestId)}`,
    );
  }

  /**
   * Blocks until a durable request is answered from a device, or the deadline passes. Used by a
   * runtime that opened a question and cannot proceed until it has the user's choice.
   */
  async waitForAnswer(
    agentId: string,
    requestId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<string | undefined> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    const pollMs = options.pollMs ?? 1_000;
    while (Date.now() < deadline) {
      try {
        const request = await this.requestStatus(agentId, requestId);
        if (request.status === "answered") return answerText(request.value);
        if (request.status !== "pending") return undefined;
      } catch {
        // Bridge restarts are transient while the runtime is blocked on the answer.
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return undefined;
  }

  async waitForDecision(
    agentId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    const pollMs = options.pollMs ?? 1_000;
    while (Date.now() < deadline) {
      try {
        const decision = (await this.commands(agentId)).find(
          (command) => command.action === "approve" || command.action === "reject",
        );
        if (decision) {
          await this.acknowledge(agentId, decision.id);
          return decision.action === "approve";
        }
      } catch {
        // Network and bridge restarts are transient while a native tool call is blocked.
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
  }
}

export function clip(value: unknown, limit = 240): string {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

/** Bounds rich response/code text without destroying Markdown-significant line breaks. */
export function clipMultiline(value: unknown, limit = 64_000): string {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
