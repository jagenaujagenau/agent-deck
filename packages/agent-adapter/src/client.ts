import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isJsonString } from "./json-value";
import type { JsonValue } from "./json-value";
import type { CanonicalRuntimeEvent } from "./runtime-events";
import { createRuntimePublisher } from "./runtime-publisher";
import type { RuntimePublisher } from "./runtime-publisher";

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
  | "follow_up"
  | "set_model";

/**
 * The heartbeat as an adapter posts it — a deliberate restatement of the
 * bridge's `Heartbeat` schema, not an import of it: adapters stay
 * dependency-light and never pull the server's Effect graph. The contract
 * suite (apps/server/src/contract.test.ts) is what holds the two in step;
 * change a field there and here together.
 */
export type AgentHeartbeat = {
  id: string;
  name: string;
  project: string;
  /** The directory the session works in, on the bridge's machine. */
  cwd?: string;
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
  /** What the run was asked to do — the Task call's own wording. */
  subagentName?: string;
  /** Which exchange this belongs to — the deck's thread unit. */
  turnId?: string;
};

export type RemoteCommand = {
  id: string;
  action: ControlAction;
  value?: string;
  createdAt?: string;
};

/**
 * How the client reaches the bridge and how it waits.
 *
 * `transport` and `sleep` exist so a caller can supply both. The park loops
 * below hold a request open for up to 25 seconds and then sleep — against
 * global `fetch` and global `setTimeout` that can only be exercised by a
 * real socket and real wall-clock time, which is why the fake-harness e2e
 * had to spawn a process per hook beat rather than drive the handler in
 * process. Injected, an approval waiting on a decision is a test that
 * answers on its own schedule.
 */
export type AdapterClientOptions = {
  baseUrl?: string;
  token?: string | (() => string);
  timeoutMs?: number;
  /**
   * Defaults to global `fetch`, read at call time. Typed as the function the
   * client actually calls rather than `typeof fetch`, whose runtime statics
   * (Bun hangs `preconnect` off it) a substitute has no reason to carry.
   */
  transport?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
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
export function answerText(value: JsonValue | undefined): string | undefined {
  if (isJsonString(value)) return value;
  if (isJsonObject(value)) {
    const entries = Object.values(value).filter(isJsonString);
    if (entries.length === 1) return entries[0];
  }
  return value === undefined || value === null ? undefined : JSON.stringify(value);
}

export class AgentDeckClient {
  readonly baseUrl: string;
  private readonly token: string | (() => string);
  private readonly timeoutMs: number;
  private readonly transport: AdapterClientOptions["transport"];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AdapterClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.AGENT_DECK_URL ??
      "http://127.0.0.1:3000"
    ).replace(/\/$/, "");
    this.token = options.token ?? runtimeToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    // Held as given, not defaulted at construction: a caller that swaps
    // `globalThis.fetch` after building a client — which is how the pi
    // adapter's tests fake a bridge — must still be the one answering.
    this.transport = options.transport;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    const token = this.token instanceof Function ? this.token() : this.token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const send = this.transport ?? globalThis.fetch;
    const response = await send(`${this.baseUrl}/bridge/v1${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Bridge ${response.status}: ${await response.text()}`);
    // SAFETY: the bridge answers JSON on every endpoint; each caller names the
    // response shape of the endpoint it is reading.
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

  /** A Runtime Event publisher speaking as `source`, delivering through this client. */
  publisher(source: string): RuntimePublisher {
    return createRuntimePublisher({
      source,
      send: async (event) => {
        await this.runtimeEvent(event);
      },
    });
  }

  /**
   * The agent's queued commands — parked on the bridge for up to
   * `waitSeconds` when none are pending yet, so a blocked adapter learns of
   * a decision on the change that queues it instead of on its next poll.
   */
  async commands(agentId: string, waitSeconds = 0): Promise<RemoteCommand[]> {
    const wait = waitSeconds > 0 ? `?wait=${Math.min(waitSeconds, 25)}` : "";
    const result = await this.request<{ commands: RemoteCommand[] }>(
      `/agents/${encodeURIComponent(agentId)}/commands${wait}`,
      {},
      waitSeconds > 0 ? Math.min(waitSeconds, 25) * 1_000 + this.timeoutMs : this.timeoutMs,
    );
    return result.commands;
  }

  async acknowledge(agentId: string, commandId: string): Promise<void> {
    await this.request(
      `/agents/${encodeURIComponent(agentId)}/commands/${encodeURIComponent(commandId)}/ack`,
      { method: "POST" },
    );
  }

  /** The request's standing — parked on the bridge while it stays pending, like `commands`. */
  requestStatus(agentId: string, requestId: string, waitSeconds = 0) {
    const wait = waitSeconds > 0 ? `?wait=${Math.min(waitSeconds, 25)}` : "";
    return this.request<{ status: string; value?: JsonValue }>(
      `/agents/${encodeURIComponent(agentId)}/requests/${encodeURIComponent(requestId)}${wait}`,
      {},
      waitSeconds > 0 ? Math.min(waitSeconds, 25) * 1_000 + this.timeoutMs : this.timeoutMs,
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
      const asked = Date.now();
      try {
        // Parked on the bridge: the answer arrives on the change that
        // resolves it, not on the next poll.
        const request = await this.requestStatus(agentId, requestId, 25);
        if (request.status === "answered") return answerText(request.value);
        if (request.status !== "pending") return undefined;
      } catch {
        // Bridge restarts are transient while the runtime is blocked on the answer.
      }
      // A bridge that ignores `wait` answers immediately; without this pause
      // the loop would spin. A parked response longer than the pause loops
      // straight back into the next park.
      if (Date.now() - asked < pollMs) await this.sleep(pollMs);
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
      const asked = Date.now();
      try {
        // Parked on the bridge, same as waitForAnswer.
        const decision = (await this.commands(agentId, 25)).find(
          (command) => command.action === "approve" || command.action === "reject",
        );
        if (decision) {
          await this.acknowledge(agentId, decision.id);
          return decision.action === "approve";
        }
      } catch {
        // Network and bridge restarts are transient while a native tool call is blocked.
      }
      if (Date.now() - asked < pollMs) await this.sleep(pollMs);
    }
    return false;
  }
}

export function clip(value: JsonValue | undefined, limit = 240): string {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

/** Bounds rich response/code text without destroying Markdown-significant line breaks. */
export function clipMultiline(value: JsonValue | undefined, limit = 64_000): string {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
