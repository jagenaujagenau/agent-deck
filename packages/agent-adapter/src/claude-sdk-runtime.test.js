import { describe, expect, test } from "bun:test";
import { ClaudeSdkManagedRuntimeAdapter } from "./claude-sdk-runtime";
class RequestStore {
    opened;
    result;
    waiter;
    async open(request) { this.opened = request; }
    async resolve(_requestId, status, value) {
        this.result = { status, value };
        this.waiter?.(this.result);
    }
    async waitForResolution(_requestId, signal) {
        if (this.result)
            return this.result;
        return new Promise((resolve, reject) => {
            this.waiter = resolve;
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
    }
}
function dormantQuery() {
    let resolveNext;
    const iterator = {
        next: () => new Promise((resolve) => { resolveNext = resolve; }),
        return: async () => ({ done: true, value: undefined }),
        throw: async (error) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        interrupt: async () => undefined,
        close: () => resolveNext?.({ done: true, value: undefined }),
    };
    return iterator;
}
describe("ClaudeSdkManagedRuntimeAdapter", () => {
    test("parks SDK permissions in the durable request store", async () => {
        const store = new RequestStore();
        let canUseTool;
        const adapter = new ClaudeSdkManagedRuntimeAdapter(store, ({ options }) => {
            canUseTool = options.canUseTool;
            return dormantQuery();
        });
        const session = await adapter.start({ agentId: "managed-1", project: "deck", cwd: "/tmp" });
        const abort = new AbortController();
        const decision = canUseTool("Bash", { command: "rm -rf build" }, {
            signal: abort.signal, toolUseID: "tool-1", requestId: "native-request-1", title: "Run destructive command",
        });
        await Bun.sleep(0);
        expect(store.opened?.requestId).toBe("native-request-1");
        expect(store.opened?.payload.tool).toBe("Bash");
        await adapter.resolveRequest(session, "native-request-1", "approved");
        expect(await decision).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } });
        await adapter.stop(session);
    });
    test("leaves auto-mode permission decisions with Claude", async () => {
        const store = new RequestStore();
        let options = {};
        const adapter = new ClaudeSdkManagedRuntimeAdapter(store, (input) => {
            options = input.options;
            return dormantQuery();
        });
        const session = await adapter.start({ agentId: "managed-auto", project: "deck", cwd: "/tmp", permissionMode: "auto" });
        expect(options.permissionMode).toBe("auto");
        expect(options.canUseTool).toBeUndefined();
        expect(store.opened).toBeUndefined();
        await adapter.stop(session);
    });
    test("fails closed when a durable request expires", async () => {
        const store = new RequestStore();
        let canUseTool;
        const adapter = new ClaudeSdkManagedRuntimeAdapter(store, ({ options }) => {
            canUseTool = options.canUseTool;
            return dormantQuery();
        });
        const session = await adapter.start({ agentId: "managed-2", project: "deck", cwd: "/tmp" });
        const decision = canUseTool("Write", { file_path: "/tmp/a" }, {
            signal: new AbortController().signal, toolUseID: "tool-2", requestId: "native-request-2",
        });
        await Bun.sleep(0);
        await adapter.resolveRequest(session, "native-request-2", "expired");
        expect((await decision)?.behavior).toBe("deny");
        await adapter.stop(session);
    });
});
