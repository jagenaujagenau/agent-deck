import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "./json-value";
import type { CanonicalRuntimeEvent, RuntimeRequestStatus } from "./runtime-events";
import type { ManagedRuntimeAdapter, ManagedSession } from "./managed-runtime";

export type DurableManagedRequest = {
  requestId: string;
  agentId: string;
  kind: "approval" | "user-input";
  payload: JsonObject;
  createdAt: string;
  expiresAt: string;
};

export interface ManagedRequestStore {
  open(request: DurableManagedRequest): Promise<void>;
  /** The value is stored opaquely; the runtime that asked knows its shape. */
  resolve<Value>(requestId: string, status: RuntimeRequestStatus, value?: Value): Promise<void>;
  waitForResolution(
    requestId: string,
    signal: AbortSignal,
  ): Promise<{ status: RuntimeRequestStatus; value?: unknown }>;
}

type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

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
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
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

// SAFETY: every structured value this adapter forwards — SDK message fields
// decoded from the Claude subprocess's JSON stream, resolution values the
// request store persisted as JSON — is JSON data by construction.
const asJsonValue = <Value>(value: Value): JsonValue => value as JsonValue;

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

  async start(input: {
    agentId: string;
    project: string;
    cwd: string;
    model?: string;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  }): Promise<ManagedSession> {
    if (this.#sessions.has(input.agentId))
      throw new Error(`Managed Claude session already exists: ${input.agentId}`);
    const session: ManagedSession = {
      agentId: input.agentId,
      providerSessionId: input.agentId,
      project: input.project,
      model: input.model ?? "claude",
    };
    const prompts = new AsyncPushQueue<SDKUserMessage>();
    const events = new AsyncPushQueue<CanonicalRuntimeEvent>();
    const permissionMode = input.permissionMode ?? "default";
    const runtimeOwnsPermission = ["auto", "bypassPermissions", "dontAsk"].includes(permissionMode);
    const canUseTool: CanUseTool = (toolName, toolInput, options) =>
      this.#permission(session, events, toolName, toolInput, options);
    const options: Options = { cwd: input.cwd, permissionMode };
    if (input.model) options.model = input.model;
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (!runtimeOwnsPermission) options.canUseTool = canUseTool;
    const claudeQuery = this.queryFactory({ prompt: prompts, options });
    const runtime = { session, prompts, events, query: claudeQuery };
    this.#sessions.set(input.agentId, runtime);
    void this.#pump(runtime);
    events.push(this.#event(session, "session.state.changed", { state: "idle", task: "Ready" }));
    return session;
  }

  async send(session: ManagedSession, prompt: string) {
    const runtime = this.#runtime(session);
    runtime.prompts.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      shouldQuery: true,
      timestamp: stamp(),
    });
    runtime.events.push(this.#event(session, "turn.started", { prompt }));
    runtime.events.push(
      this.#event(session, "session.state.changed", { state: "running", task: "Thinking" }),
    );
  }

  async interrupt(session: ManagedSession) {
    await this.#runtime(session).query.interrupt();
  }

  async resolveRequest<Value>(
    session: ManagedSession,
    requestId: string,
    status: RuntimeRequestStatus,
    value?: Value,
  ) {
    this.#runtime(session);
    await this.requestStore.resolve(requestId, status, value);
  }

  async stop(session: ManagedSession) {
    const runtime = this.#runtime(session);
    runtime.query.close();
    runtime.prompts.close();
    runtime.events.push(
      this.#event(session, "session.state.changed", { state: "offline", task: "Stopped" }),
    );
    runtime.events.close();
    this.#sessions.delete(session.agentId);
  }

  events(session: ManagedSession): AsyncIterable<CanonicalRuntimeEvent> {
    return this.#runtime(session).events;
  }

  async #permission(
    session: ManagedSession,
    events: AsyncPushQueue<CanonicalRuntimeEvent>,
    toolName: string,
    rawInput: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // SAFETY: tool inputs are decoded from the CLI's JSON stream before the
    // SDK hands them to this callback.
    const toolInput = rawInput as JsonObject;
    const kind = toolName === "AskUserQuestion" ? "user-input" : "approval";
    const requestId = options.requestId || options.toolUseID || crypto.randomUUID();
    const createdAt = stamp();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const payload: JsonObject =
      kind === "approval"
        ? {
            kind,
            tool: toolName,
            detail: options.title ?? options.description ?? JSON.stringify(toolInput),
            input: toolInput,
            createdAt,
            expiresAt,
          }
        : { kind, questions: toolInput.questions ?? [], createdAt, expiresAt };
    await this.requestStore.open({
      requestId,
      agentId: session.agentId,
      kind,
      payload,
      createdAt,
      expiresAt,
    });
    events.push(
      this.#event(
        session,
        kind === "approval" ? "request.opened" : "user-input.requested",
        payload,
        requestId,
      ),
    );
    events.push(
      this.#event(session, "session.state.changed", {
        state: "waiting",
        task: kind === "approval" ? `Approval needed for ${toolName}` : "Claude needs your input",
      }),
    );
    const resolution = await this.requestStore
      .waitForResolution(requestId, options.signal)
      .catch(() => ({ status: "unavailable" as const, value: undefined }));
    const resolvedPayload: JsonObject = { status: resolution.status };
    if (resolution.value !== undefined) resolvedPayload.value = asJsonValue(resolution.value);
    events.push(
      this.#event(
        session,
        kind === "approval" ? "request.resolved" : "user-input.resolved",
        resolvedPayload,
        requestId,
      ),
    );
    events.push(
      this.#event(session, "session.state.changed", { state: "running", task: "Continuing" }),
    );
    if (kind === "user-input" && resolution.status === "answered") {
      return { behavior: "allow", updatedInput: { ...toolInput, answers: resolution.value } };
    }
    if (resolution.status === "approved") return { behavior: "allow", updatedInput: toolInput };
    return {
      behavior: "deny",
      message:
        resolution.status === "expired"
          ? "Remote approval expired."
          : "Remote approval was not granted.",
    };
  }

  async #pump(runtime: SessionRuntime) {
    try {
      for await (const message of runtime.query) this.#translate(runtime, message);
      runtime.events.push(this.#event(runtime.session, "turn.completed", { outcome: "completed" }));
      runtime.events.push(
        this.#event(runtime.session, "session.state.changed", { state: "idle", task: "Done" }),
      );
    } catch (error) {
      runtime.events.push(
        this.#event(runtime.session, "runtime.error", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      runtime.events.push(
        this.#event(runtime.session, "session.state.changed", {
          state: "error",
          task: "Claude runtime failed",
        }),
      );
    }
  }

  #translate(runtime: SessionRuntime, message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init")
      runtime.session.providerSessionId = message.session_id;
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          runtime.events.push(
            this.#event(
              runtime.session,
              "item.started",
              { kind: "tool", tool: block.name, input: asJsonValue(block.input) },
              undefined,
              block.id,
            ),
          );
        } else if (block.type === "thinking" && block.thinking.trim()) {
          runtime.events.push(
            this.#event(
              runtime.session,
              "item.completed",
              { kind: "reasoning", text: block.thinking },
              undefined,
              `reasoning:${message.uuid}`,
            ),
          );
        } else if (block.type === "text" && block.text.trim()) {
          runtime.events.push(
            this.#event(
              runtime.session,
              "item.completed",
              { kind: "output", text: block.text },
              undefined,
              message.uuid,
            ),
          );
        }
      }
      const usage = message.message.usage;
      if (usage)
        runtime.events.push(
          this.#event(runtime.session, "token-usage.updated", { usage: asJsonValue(usage) }),
        );
    }
    if (message.type === "result") {
      // Only the error-subtype result carries an errors list; a success never
      // reports an interrupt through it.
      const interrupted = JSON.stringify(
        message.subtype === "success" ? "" : (message.errors ?? ""),
      )
        .toLowerCase()
        .includes("interrupt");
      const completed: JsonObject = {
        outcome: interrupted ? "interrupted" : message.subtype,
        costUsd: message.total_cost_usd,
      };
      if (message.subtype === "success") completed.result = message.result;
      runtime.events.push(this.#event(runtime.session, "turn.completed", completed));
      runtime.events.push(
        this.#event(runtime.session, "session.state.changed", {
          state: interrupted ? "paused" : message.subtype === "success" ? "idle" : "error",
          task: interrupted
            ? "Interrupted"
            : message.subtype === "success"
              ? "Done"
              : "Claude turn failed",
        }),
      );
    }
  }

  #event(
    session: ManagedSession,
    type: CanonicalRuntimeEvent["type"],
    payload: JsonObject,
    requestId?: string,
    itemId?: string,
  ): CanonicalRuntimeEvent {
    const event: CanonicalRuntimeEvent = {
      id: eventId(),
      agentId: session.agentId,
      type,
      createdAt: stamp(),
      payload,
    };
    if (requestId) event.requestId = requestId;
    if (itemId) event.itemId = itemId;
    return event;
  }

  #runtime(session: ManagedSession) {
    const runtime = this.#sessions.get(session.agentId);
    if (!runtime) throw new Error(`Managed Claude session unavailable: ${session.agentId}`);
    return runtime;
  }
}
