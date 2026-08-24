import { query } from "@anthropic-ai/claude-agent-sdk";
class AsyncPushQueue {
    #values = [];
    #waiters = [];
    #closed = false;
    push(value) {
        if (this.#closed)
            return;
        const waiter = this.#waiters.shift();
        if (waiter)
            waiter({ value, done: false });
        else
            this.#values.push(value);
    }
    close() {
        this.#closed = true;
        while (this.#waiters.length)
            this.#waiters.shift()?.({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
        return {
            next: async () => {
                const value = this.#values.shift();
                if (value !== undefined)
                    return { value, done: false };
                if (this.#closed)
                    return { value: undefined, done: true };
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
export class ClaudeSdkManagedRuntimeAdapter {
    requestStore;
    queryFactory;
    runtime = "claude";
    capabilities = { interrupt: true, approvals: true, userInput: true, modelSwitch: true };
    #sessions = new Map();
    constructor(requestStore, queryFactory = ({ prompt, options }) => query({ prompt, options })) {
        this.requestStore = requestStore;
        this.queryFactory = queryFactory;
    }
    async start(input) {
        if (this.#sessions.has(input.agentId))
            throw new Error(`Managed Claude session already exists: ${input.agentId}`);
        const session = { agentId: input.agentId, providerSessionId: input.agentId, project: input.project, model: input.model ?? "claude" };
        const prompts = new AsyncPushQueue();
        const events = new AsyncPushQueue();
        const permissionMode = input.permissionMode ?? "default";
        const runtimeOwnsPermission = ["auto", "bypassPermissions", "dontAsk"].includes(permissionMode);
        const canUseTool = (toolName, toolInput, options) => this.#permission(session, events, toolName, toolInput, options);
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
    async send(session, prompt) {
        const runtime = this.#runtime(session);
        runtime.prompts.push({
            type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null,
            shouldQuery: true, timestamp: stamp(),
        });
        runtime.events.push(this.#event(session, "turn.started", { prompt }));
        runtime.events.push(this.#event(session, "session.state.changed", { state: "running", task: "Thinking" }));
    }
    async interrupt(session) { await this.#runtime(session).query.interrupt(); }
    async resolveRequest(session, requestId, status, value) {
        this.#runtime(session);
        await this.requestStore.resolve(requestId, status, value);
    }
    async stop(session) {
        const runtime = this.#runtime(session);
        runtime.query.close();
        runtime.prompts.close();
        runtime.events.push(this.#event(session, "session.state.changed", { state: "offline", task: "Stopped" }));
        runtime.events.close();
        this.#sessions.delete(session.agentId);
    }
    events(session) { return this.#runtime(session).events; }
    async #permission(session, events, toolName, toolInput, options) {
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
        let resolution;
        try {
            resolution = await this.requestStore.waitForResolution(requestId, options.signal);
        }
        catch {
            resolution = { status: "unavailable" };
        }
        events.push(this.#event(session, kind === "approval" ? "request.resolved" : "user-input.resolved", { status: resolution.status, value: resolution.value }, requestId));
        events.push(this.#event(session, "session.state.changed", { state: "running", task: "Continuing" }));
        if (kind === "user-input" && resolution.status === "answered") {
            return { behavior: "allow", updatedInput: { ...toolInput, answers: resolution.value } };
        }
        if (resolution.status === "approved")
            return { behavior: "allow", updatedInput: toolInput };
        return { behavior: "deny", message: resolution.status === "expired" ? "Remote approval expired." : "Remote approval was not granted." };
    }
    async #pump(runtime) {
        try {
            for await (const message of runtime.query)
                this.#translate(runtime, message);
            runtime.events.push(this.#event(runtime.session, "turn.completed", { outcome: "completed" }));
            runtime.events.push(this.#event(runtime.session, "session.state.changed", { state: "idle", task: "Done" }));
        }
        catch (error) {
            runtime.events.push(this.#event(runtime.session, "runtime.error", { message: error instanceof Error ? error.message : String(error) }));
            runtime.events.push(this.#event(runtime.session, "session.state.changed", { state: "error", task: "Claude runtime failed" }));
        }
    }
    #translate(runtime, message) {
        const raw = message;
        if (raw.type === "system" && raw.subtype === "init" && typeof raw.session_id === "string")
            runtime.session.providerSessionId = raw.session_id;
        if (raw.type === "assistant") {
            const body = raw.message;
            const content = Array.isArray(body?.content) ? body.content : [];
            for (const block of content) {
                if (block.type === "tool_use" && typeof block.id === "string") {
                    runtime.events.push(this.#event(runtime.session, "item.started", { kind: "tool", tool: block.name, input: block.input }, undefined, block.id));
                }
                else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                    runtime.events.push(this.#event(runtime.session, "item.completed", { kind: "output", text: block.text }, undefined, typeof raw.uuid === "string" ? raw.uuid : undefined));
                }
            }
            const usage = body?.usage;
            if (usage)
                runtime.events.push(this.#event(runtime.session, "token-usage.updated", { usage }));
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
    #event(session, type, payload, requestId, itemId) {
        return { id: eventId(), agentId: session.agentId, type, createdAt: stamp(), payload, ...(requestId ? { requestId } : {}), ...(itemId ? { itemId } : {}) };
    }
    #runtime(session) {
        const runtime = this.#sessions.get(session.agentId);
        if (!runtime)
            throw new Error(`Managed Claude session unavailable: ${session.agentId}`);
        return runtime;
    }
}
