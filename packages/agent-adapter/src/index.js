import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export * from "./runtime-events";
export * from "./runtime-projector";
export * from "./managed-runtime";
export * from "./claude-sdk-runtime";
const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "agent-deck", "runtime-token");
export function runtimeToken() {
    if (process.env.AGENT_DECK_TOKEN)
        return process.env.AGENT_DECK_TOKEN;
    try {
        return readFileSync(process.env.AGENT_DECK_TOKEN_FILE ?? DEFAULT_TOKEN_FILE, "utf8").trim();
    }
    catch {
        return "";
    }
}
export class AgentDeckClient {
    baseUrl;
    token;
    timeoutMs;
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl ?? process.env.AGENT_DECK_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
        this.token = options.token ?? runtimeToken;
        this.timeoutMs = options.timeoutMs ?? 5_000;
    }
    async request(path, init = {}) {
        const headers = new Headers(init.headers);
        headers.set("Content-Type", "application/json");
        const token = typeof this.token === "function" ? this.token() : this.token;
        if (token)
            headers.set("Authorization", `Bearer ${token}`);
        const response = await fetch(`${this.baseUrl}/bridge/v1${path}`, {
            ...init,
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok)
            throw new Error(`Bridge ${response.status}: ${await response.text()}`);
        return response.json();
    }
    heartbeat(agent) {
        return this.request("/agents/heartbeat", {
            method: "POST",
            body: JSON.stringify({ ...agent, tokens: agent.tokens ?? 0, costUsd: agent.costUsd ?? 0 }),
        });
    }
    event(agentId, event) {
        return this.request(`/agents/${encodeURIComponent(agentId)}/events`, {
            method: "POST",
            body: JSON.stringify(event),
        });
    }
    runtimeEvent(event) {
        return this.request(`/agents/${encodeURIComponent(event.agentId)}/runtime-events`, {
            method: "POST",
            body: JSON.stringify(event),
        });
    }
    async commands(agentId) {
        const result = await this.request(`/agents/${encodeURIComponent(agentId)}/commands`);
        return result.commands;
    }
    acknowledge(agentId, commandId) {
        return this.request(`/agents/${encodeURIComponent(agentId)}/commands/${encodeURIComponent(commandId)}/ack`, { method: "POST" });
    }
    async waitForDecision(agentId, options = {}) {
        const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
        const pollMs = options.pollMs ?? 1_000;
        while (Date.now() < deadline) {
            try {
                const decision = (await this.commands(agentId)).find((command) => command.action === "approve" || command.action === "reject");
                if (decision) {
                    await this.acknowledge(agentId, decision.id);
                    return decision.action === "approve";
                }
            }
            catch {
                // Network and bridge restarts are transient while a native tool call is blocked.
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        return false;
    }
}
export function clip(value, limit = 240) {
    const compact = String(value ?? "").replace(/\s+/g, " ").trim();
    return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}
