import { describe, expect, test } from "bun:test";
import { ManagedRuntimeRegistry, type ManagedRuntimeAdapter } from "./managed-runtime";

function adapter(runtime: ManagedRuntimeAdapter["runtime"]): ManagedRuntimeAdapter {
  return {
    runtime,
    capabilities: { interrupt: true, approvals: true, userInput: true, modelSwitch: false },
    async start(input) { return { agentId: input.agentId, providerSessionId: `${runtime}-1`, project: input.project, model: input.model ?? runtime }; },
    async send() {}, async interrupt() {}, async resolveRequest() {}, async stop() {},
    async *events() {},
  };
}

describe("ManagedRuntimeRegistry", () => {
  test("routes independent Claude and Codex adapters", () => {
    const registry = new ManagedRuntimeRegistry();
    registry.register(adapter("claude"));
    registry.register(adapter("codex"));
    expect(registry.get("claude").runtime).toBe("claude");
    expect(registry.available().map((entry) => entry.runtime)).toEqual(["claude", "codex"]);
  });
});
