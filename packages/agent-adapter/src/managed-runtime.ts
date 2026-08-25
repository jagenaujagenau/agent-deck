import type { CanonicalRuntimeEvent, RuntimeRequestStatus } from "./runtime-events";

export type ManagedRuntimeCapabilities = {
  interrupt: boolean;
  approvals: boolean;
  userInput: boolean;
  modelSwitch: boolean;
};

export type ManagedSession = {
  agentId: string;
  providerSessionId: string;
  project: string;
  model: string;
};

/**
 * Host-owned runtime seam. Native Claude/Codex/ACP implementations satisfy
 * this interface; externally launched sessions continue through hook adapters.
 */
export interface ManagedRuntimeAdapter {
  readonly runtime: "claude" | "codex" | "acp";
  readonly capabilities: ManagedRuntimeCapabilities;
  start(input: {
    agentId: string;
    project: string;
    cwd: string;
    model?: string;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  }): Promise<ManagedSession>;
  send(session: ManagedSession, prompt: string): Promise<void>;
  interrupt(session: ManagedSession): Promise<void>;
  resolveRequest(
    session: ManagedSession,
    requestId: string,
    status: RuntimeRequestStatus,
    value?: unknown,
  ): Promise<void>;
  stop(session: ManagedSession): Promise<void>;
  events(session: ManagedSession): AsyncIterable<CanonicalRuntimeEvent>;
}

export class ManagedRuntimeRegistry {
  readonly #adapters = new Map<string, ManagedRuntimeAdapter>();

  register(adapter: ManagedRuntimeAdapter) {
    if (this.#adapters.has(adapter.runtime))
      throw new Error(`Managed runtime already registered: ${adapter.runtime}`);
    this.#adapters.set(adapter.runtime, adapter);
  }

  get(runtime: ManagedRuntimeAdapter["runtime"]): ManagedRuntimeAdapter {
    const adapter = this.#adapters.get(runtime);
    if (!adapter) throw new Error(`Managed runtime unavailable: ${runtime}`);
    return adapter;
  }

  available() {
    return [...this.#adapters.values()].map((adapter) => ({
      runtime: adapter.runtime,
      capabilities: adapter.capabilities,
    }));
  }
}
