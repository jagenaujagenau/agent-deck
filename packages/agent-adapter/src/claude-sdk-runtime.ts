import { query, type CanUseTool, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CanonicalRuntimeEvent, RuntimeRequestStatus } from "./runtime-events";
import type { ManagedRuntimeAdapter, ManagedSession } from "./managed-runtime";

export type DurableManagedRequest = {
  requestId: string;
  agentId: string;
  kind: "approval" | "user-input";
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
};

export interface ManagedRequestStore {
  open(request: DurableManagedRequest): Promise<void>;
  resolve(requestId: string, status: RuntimeRequestStatus, value?: unknown): Promise<void>;
  waitForResolution(requestId: string, signal: AbortSignal): Promise<{ status: RuntimeRequestStatus; value?: unknown }>;
}

type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => Query;

type SessionRuntime = {
  session: ManagedSession;
  prompts: AsyncPushQueue<SDKUserMessage>;
  events: AsyncPushQueue<CanonicalRuntimeEvent>;
  query: Query;
};

class AsyncPushQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    while (this.#waiters.length) this.#waiters.shift()?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const stamp = () => new Date().toISOString();
const eventId = () => crypto.randomUUID();

/**
 * Host-owned Claude runtime Implementation.
 *
 * Permission callbacks park on ManagedRequestStore, not an in-memory Deferred.
 * A server restart therefore preserves the request and decision record. The
 * Claude subprocess is still process-owned; unresolved requests are recovered
 * as terminal/unavailable when that process cannot be resumed.
 */
export class ClaudeSdkManagedRuntimeAdapter implements ManagedRuntimeAdapter {
  readonly runtime = "claude" as const;
  readonly capabilities = { interrupt: true, approvals: true, userInput: true, modelSwitch: true };
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(
    readonly requestStore: ManagedRequestStore,
    readonly queryFactory: QueryFactory = ({ prompt, options }) => query({ prompt, options }),
  ) {}

  async start(input: { agentId: string; project: string; cwd: string; model?: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto" }): Promise<ManagedSession> {
    if (this.#sessions.has(input.agentId)) throw new Error(`Managed Claude session already exists: ${input.agentId}`);
    const session: ManagedSession = { agentId: input.agentId, providerSessionId: input.agentId, project: input.project, model: input.model ?? "claude" };
    const prompts = new AsyncPushQueue<SDKUserMessage>();
    const events = new AsyncPushQueue<CanonicalRuntimeEvent>();
    const permissionMode = input.permissionMode ?? "default";
    const runtimeOwnsPermission = ["auto", "bypassPermissions", "dontAsk"].includes(permissionMode);
    const canUseTool: CanUseTool = (toolName, toolInput, options) => this.#permission(session, events, toolName, toolInput, options);
    const claudeQuery = this.queryFactory({
      prompt: prompts,
      options: {
        cwd: input.cwd, ...(input.model ? { model: input.model } : {}), permissionMode,
        ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        ...(!runtimeOwnsPermission ? { canUseTool } : {}),
      },
    });
    const runtime = { session, prompts, events, query: claudeQuery };
    this.#sessions.set(input.agentId, runtime);
    void this.#pump(runtime);
    events.push(this.#event(session, "session.state.changed", { state: "idle", task: "Ready" }));
    return session;
  }

  async send(session: ManagedSession, prompt: string) {
    const runtime = this.#runtime(session);
    runtime.prompts.push({
      type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null,
      shouldQuery: true, timestamp: stamp(),
    });
    runtime.events.push(this.#event(session, "turn.started", { prompt }));
    runtime.events.push(this.#event(session, "session.state.changed", { state: "running", task: "Thinking" }));
  }

  async interrupt(session: ManagedSession) { await this.#runtime(session).query.interrupt(); }

  async resolveRequest(session: ManagedSession, requestId: string, status: RuntimeRequestStatus, value?: unknown) {
    this.#runtime(session);
    await this.requestStore.resolve(requestId, status, value);
  }

  async stop(session: ManagedSession) {
    const runtime = this.#runtime(session);
    runtime.query.close();
    runtime.prompts.close();
    runtime.events.push(this.#event(session, "session.state.changed", { state: "offline", task: "Stopped" }));
    runtime.events.close();
    this.#sessions.delete(session.agentId);
  }

  events(session: ManagedSession): AsyncIterable<CanonicalRuntimeEvent> { return this.#runtime(session).events; }

  async #permission(
    session: ManagedSession,
    events: AsyncPushQueue<CanonicalRuntimeEvent>,
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const kind = toolName === "AskUserQuestion" ? "user-input" : "approval";
    const requestId = options.requestId || options.toolUseID || crypto.randomUUID();
    const createdAt = stamp();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const payload = kind === "approval"
      ? { kind, tool: toolName, detail: options.title ?? options.description ?? JSON.stringify(toolInput), input: toolInput, createdAt, expiresAt }
      : { kind, questions: toolInput.questions ?? [], createdAt, expiresAt };
    await this.requestStore.open({ requestId, agentId: session.agentId, kind, payload, createdAt, expiresAt });
    events.push(this.#event(session, kind === "approval" ? "request.opened" : "user-input.requested", payload, requestId));
    events.push(this.#event(session, "session.state.changed", { state: "waiting", task: kind === "approval" ? `Approval needed for ${toolName}` : "Claude needs your input" }));
    let resolution: { status: RuntimeRequestStatus; value?: unknown };
    try { resolution = await this.requestStore.waitForResolution(requestId, options.signal); }
    catch { resolution = { status: "unavailable" }; }
    events.push(this.#event(session, kind === "approval" ? "request.resolved" : "user-input.resolved", { status: resolution.status, value: resolution.value }, requestId));
    events.push(this.#event(session, "session.state.changed", { state: "running", task: "Continuing" }));
    if (kind === "user-input" && resolution.status === "answered") {
      return { behavior: "allow", updatedInput: { ...toolInput, answers: resolution.value } };
    }
    if (resolution.status === "approved") return { behavior: "allow", updatedInput: toolInput };
    return { behavior: "deny", message: resolution.status === "expired" ? "Remote approval expired." : "Remote approval was not granted." };
  }

  async #pump(runtime: SessionRuntime) {
    try {
      for await (const message of runtime.query) this.#translate(runtime, message);
      runtime.events.push(this.#event(runtime.session, "turn.completed", { outcome: "completed" }));
      runtime.events.push(this.#event(runtime.session, "session.state.changed", { state: "idle", task: "Done" }));
    } catch (error) {
      runtime.events.push(this.#event(runtime.session, "runtime.error", { message: error instanceof Error ? error.message : String(error) }));
      runtime.events.push(this.#event(runtime.session, "session.state.changed", { state: "error", task: "Claude runtime failed" }));
    }
  }

  #translate(runtime: SessionRuntime, message: SDKMessage) {
    const raw = message as unknown as Record<string, unknown>;
    if (raw.type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") runtime.session.providerSessionId = raw.session_id;
    if (raw.type === "assistant") {
      const body = raw.message as Record<string, unknown> | undefined;
      const content = Array.isArray(body?.content) ? body.content as Array<Record<string, unknown>> : [];
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          runtime.events.push(this.#event(runtime.session, "item.started", { kind: "tool", tool: block.name, input: block.input }, undefined, block.id));
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          runtime.events.push(this.#event(runtime.session, "item.completed", { kind: "reasoning", text: block.thinking }, undefined, typeof raw.uuid === "string" ? `reasoning:${raw.uuid}` : undefined));
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          runtime.events.push(this.#event(runtime.session, "item.completed", { kind: "output", text: block.text }, undefined, typeof raw.uuid === "string" ? raw.uuid : undefined));
        }
      }
      const usage = body?.usage as Record<string, unknown> | undefined;
      if (usage) runtime.events.push(this.#event(runtime.session, "token-usage.updated", { usage }));
    }
    if (raw.type === "result") {
      const interrupted = JSON.stringify(raw.errors ?? "").toLowerCase().includes("interrupt");
      runtime.events.push(this.#event(runtime.session, "turn.completed", { outcome: interrupted ? "interrupted" : raw.subtype, result: raw.result, costUsd: raw.total_cost_usd }));
      runtime.events.push(this.#event(runtime.session, "session.state.changed", {
        state: interrupted ? "paused" : raw.subtype === "success" ? "idle" : "error",
        task: interrupted ? "Interrupted" : raw.subtype === "success" ? "Done" : "Claude turn failed",
      }));
    }
  }

  #event(session: ManagedSession, type: CanonicalRuntimeEvent["type"], payload: Record<string, unknown>, requestId?: string, itemId?: string): CanonicalRuntimeEvent {
    return { id: eventId(), agentId: session.agentId, type, createdAt: stamp(), payload, ...(requestId ? { requestId } : {}), ...(itemId ? { itemId } : {}) };
  }

  #runtime(session: ManagedSession) {
    const runtime = this.#sessions.get(session.agentId);
    if (!runtime) throw new Error(`Managed Claude session unavailable: ${session.agentId}`);
    return runtime;
  }
}
