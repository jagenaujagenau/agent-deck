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
 * One model a runtime will answer as, in the runtime's own words.
 *
 * The deck never invents this list: a model shipped after the phone was
 * installed would be missing from any catalog compiled into the app, and a
 * model the account cannot reach would be offered by any catalog we wrote
 * ourselves. `id` is what a caller passes back to select it; `resolvedModel`
 * is what an alias like "sonnet" actually resolves to, so a session started
 * on an explicit id can still be matched to the row that covers it.
 */
export type RuntimeModel = {
  id: string;
  label: string;
  description?: string;
  resolvedModel?: string;
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
  /**
   * The resolution value is carried through untouched: only the runtime that
   * opened the request knows its shape, so the adapter never inspects it.
   */
  resolveRequest<Value>(
    session: ManagedSession,
    requestId: string,
    status: RuntimeRequestStatus,
    value?: Value,
  ): Promise<void>;
  stop(session: ManagedSession): Promise<void>;
  events(session: ManagedSession): AsyncIterable<CanonicalRuntimeEvent>;
  /**
   * The models this runtime will answer as, asked of the runtime rather than
   * remembered. Only meaningful when `capabilities.modelSwitch` — an adapter
   * that cannot switch has no list worth showing.
   */
  models?(session: ManagedSession): Promise<ReadonlyArray<RuntimeModel>>;
  /**
   * Switches the model of a live session. The session's `model` is updated by
   * the caller only once this resolves, so a refused switch leaves the deck
   * saying what the runtime is actually running.
   */
  setModel?(session: ManagedSession, model: string): Promise<void>;
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
