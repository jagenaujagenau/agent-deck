import { describe, expect, test } from "bun:test";
import { emptyRuntimeProjection, projectRuntimeEvent } from "./runtime-projector";
const event = (type, overrides = {}) => ({
    id: crypto.randomUUID(), agentId: "agent-1", type, createdAt: "2026-08-24T00:00:00.000Z", payload: {}, ...overrides,
});
describe("projectRuntimeEvent", () => {
    test("derives request attention only from an open request", () => {
        const opened = projectRuntimeEvent(emptyRuntimeProjection("agent-1"), event("request.opened", { requestId: "r1", payload: { tool: "Bash" } }), 1);
        expect(opened.state).toBe("waiting");
        expect(opened.pendingRequest?.id).toBe("r1");
        const resolved = projectRuntimeEvent(opened, event("request.resolved", { requestId: "r1", payload: { status: "approved" } }), 2);
        expect(resolved.pendingRequest).toBeUndefined();
        expect(resolved.state).toBe("running");
    });
    test("rejects delayed events by sequence", () => {
        const running = projectRuntimeEvent(emptyRuntimeProjection("agent-1"), event("turn.started"), 4);
        expect(projectRuntimeEvent(running, event("session.state.changed", { payload: { state: "idle" } }), 3)).toBe(running);
    });
    test("separates context pressure from monotonic processed usage", () => {
        const first = projectRuntimeEvent(emptyRuntimeProjection("agent-1"), event("token-usage.updated", { payload: { contextTokens: 10, processedTokens: 100 } }), 1);
        const reset = projectRuntimeEvent(first, event("token-usage.updated", { payload: { contextTokens: 4, processedTokens: 90 } }), 2);
        expect(reset.contextTokens).toBe(4);
        expect(reset.processedTokens).toBe(100);
    });
});
