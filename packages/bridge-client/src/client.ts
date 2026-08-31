import { asString, isJsonObject, parseJson } from "./json-value";
import type { JsonValue } from "./json-value";
import type {
  Agent,
  AgentEvent,
  BridgeSnapshot,
  CommandReceipt,
  ControlAction,
  ManagedRuntime,
  PairedDevice,
  QueuedCommand,
  RuntimeModel,
  SlashCommand,
} from "./types";

/**
 * The bridge declined to hand a message to a session blocked on a person.
 *
 * `agent_blocked` is wire contract: the message carries the bridge's own
 * sentence about what is pending, so a caller can point at the approval or
 * question instead of reporting a code. Retry with `force: true` to queue
 * anyway — that choice belongs to the person, never to this client.
 */
export class AgentBlockedError extends Error {}

/** Any other refusal or failure, with the status that carried it. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeClientOptions {
  fetcher?: typeof fetch;
}

/**
 * The consumer verbs of the wire contract (`docs/bridge-api.md`): everything a
 * surface reads and every way it acts. Zero dependencies; give it a base URL
 * and a token from pairing.
 */
export class BridgeClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl: string,
    private token: string = "",
    options: BridgeClientOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  configure(token: string): void {
    this.token = token.trim();
  }

  // ---- reading -----------------------------------------------------------

  snapshot(): Promise<BridgeSnapshot> {
    return this.request<BridgeSnapshot>("GET", "/snapshot");
  }

  /**
   * The retained event log, oldest first. `before` pages backwards: pass the
   * oldest createdAt already held to receive the window before it.
   */
  async history(agentId: string, limit?: number, before?: string): Promise<AgentEvent[]> {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (before !== undefined) query.set("before", before);
    const suffix = query.size > 0 ? `?${query}` : "";
    const body = await this.request<{ events: AgentEvent[] }>(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/history${suffix}`,
    );
    return body.events;
  }

  async changes(agentId: string): Promise<AgentEvent[]> {
    const body = await this.request<{ changes: AgentEvent[] }>(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/changes`,
    );
    return body.changes;
  }

  /**
   * The models a bridge-hosted session will answer as, asked of the runtime.
   * A session the bridge does not host has no list — its model belongs to the
   * runtime that owns its terminal — and answers 404, which surfaces here as
   * an empty list so a caller can simply not offer the control.
   */
  async models(agentId: string): Promise<RuntimeModel[]> {
    try {
      const body = await this.request<{ models: RuntimeModel[] }>(
        "GET",
        `/agents/${encodeURIComponent(agentId)}/models`,
      );
      return body.models;
    } catch {
      return [];
    }
  }

  async slashCommands(agentId: string): Promise<SlashCommand[]> {
    const body = await this.request<{ commands: SlashCommand[] }>(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/slash-commands`,
    );
    return body.commands;
  }

  receipt(commandId: string): Promise<CommandReceipt> {
    return this.request<CommandReceipt>(
      "GET",
      `/commands/${encodeURIComponent(commandId)}/receipt`,
    );
  }

  // ---- acting --------------------------------------------------------------

  /**
   * Sends a control verb. A prompt aimed at a blocked session throws
   * `AgentBlockedError` with the bridge's sentence about what is pending;
   * pass `force: true` only after a person chose to queue anyway.
   */
  async control(
    agentId: string,
    action: ControlAction,
    value?: string,
    options: { commandId?: string; force?: boolean } = {},
  ): Promise<QueuedCommand> {
    return this.request<QueuedCommand>("POST", `/agents/${encodeURIComponent(agentId)}/control`, {
      action,
      value,
      commandId: options.commandId,
      force: options.force,
    });
  }

  /**
   * Records that a person looked at this session. Shared across surfaces:
   * apply any local mark first — the round trip must never gate a badge —
   * and call this only on an explicit view, never a machine read.
   */
  async markSeen(agentId: string): Promise<string> {
    const body = await this.request<{ viewedAt: string }>(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/seen`,
    );
    return body.viewedAt;
  }

  /**
   * Dismisses a session from the deck. History, usage, and file changes are
   * kept — this declutters the live list, it does not erase what happened. A
   * session still heartbeating reappears on its next beat.
   */
  async dismiss(agentId: string): Promise<void> {
    await this.request("DELETE", `/agents/${encodeURIComponent(agentId)}`);
  }

  async answerQuestion(agentId: string, requestId: string, answer: string): Promise<void> {
    await this.request(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/requests/${encodeURIComponent(requestId)}/resolve`,
      { status: "answered", value: { answer } },
    );
  }

  // ---- hosting ---------------------------------------------------------------

  async managedRuntimes(): Promise<ManagedRuntime[]> {
    const body = await this.request<{ runtimes: ManagedRuntime[] }>("GET", "/managed/runtimes");
    return body.runtimes;
  }

  startClaudeSession(input: {
    project: string;
    cwd: string;
    model?: string;
    objective?: string;
    prompt?: string;
    permissionMode?: string;
  }): Promise<{ agentId: string; project: string; model: string; permissionMode: string }> {
    return this.request("POST", "/managed/claude/sessions", input);
  }

  // ---- pairing ---------------------------------------------------------------

  /** The one call made before a credential exists. */
  async pair(code: string, deviceName: string): Promise<PairedDevice> {
    const device = await this.request<PairedDevice>("POST", "/pair", { code, deviceName });
    this.token = device.token;
    return device;
  }

  async revokeDevice(): Promise<void> {
    await this.request("DELETE", "/device");
  }

  // ---- plumbing ---------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, JsonValue | undefined>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token !== "") headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetcher(`${this.base}/bridge/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const refusal = parseRefusal(text);
      if (response.status === 409 && refusal?.error === "agent_blocked") {
        throw new AgentBlockedError(refusal.detail ?? "The agent is waiting on a person");
      }
      throw new BridgeError(
        response.status,
        refusal?.error ?? `Bridge returned ${response.status}`,
      );
    }
    // SAFETY: T states what the contract says this route returns; the bridge
    // is the authority on the shape, and a mismatch is a contract bug.
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  async agent(agentId: string): Promise<Agent | undefined> {
    const deck = await this.snapshot();
    return deck.agents.find((candidate) => candidate.id === agentId);
  }
}

function parseRefusal(text: string): { error?: string; detail?: string } | undefined {
  try {
    const parsed = parseJson(text);
    if (!isJsonObject(parsed)) return undefined;
    return { error: asString(parsed.error), detail: asString(parsed.detail) };
  } catch {
    return undefined;
  }
}
