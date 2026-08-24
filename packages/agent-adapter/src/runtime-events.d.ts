export type RuntimeEventType = "session.state.changed" | "turn.started" | "turn.completed" | "request.opened" | "request.resolved" | "user-input.requested" | "user-input.resolved" | "item.started" | "item.updated" | "item.completed" | "token-usage.updated" | "rate-limits.updated" | "runtime.error";
export type RuntimeRequestKind = "approval" | "user-input";
export type RuntimeRequestStatus = "pending" | "approved" | "rejected" | "answered" | "expired" | "unavailable";
export type CanonicalRuntimeEvent = {
    id: string;
    agentId: string;
    type: RuntimeEventType;
    createdAt: string;
    turnId?: string;
    itemId?: string;
    requestId?: string;
    payload: Record<string, unknown>;
};
export declare function canonicalRuntimeEvent(value: unknown): CanonicalRuntimeEvent;
export declare function stableProgressEventId(agentId: string, itemId: string, stream?: "activity" | "usage"): string;
