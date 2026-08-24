export class ManagedRuntimeRegistry {
    #adapters = new Map();
    register(adapter) {
        if (this.#adapters.has(adapter.runtime))
            throw new Error(`Managed runtime already registered: ${adapter.runtime}`);
        this.#adapters.set(adapter.runtime, adapter);
    }
    get(runtime) {
        const adapter = this.#adapters.get(runtime);
        if (!adapter)
            throw new Error(`Managed runtime unavailable: ${runtime}`);
        return adapter;
    }
    available() { return [...this.#adapters.values()].map((adapter) => ({ runtime: adapter.runtime, capabilities: adapter.capabilities })); }
}
