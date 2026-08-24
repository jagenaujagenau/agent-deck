const eventTypes = new Set([
    "session.state.changed", "turn.started", "turn.completed", "request.opened", "request.resolved",
    "user-input.requested", "user-input.resolved", "item.started", "item.updated", "item.completed",
    "token-usage.updated", "rate-limits.updated", "runtime.error",
]);
export function canonicalRuntimeEvent(value) {
    if (typeof value !== "object" || value === null)
        throw new Error("Runtime event must be an object");
    const event = value;
    if (typeof event.id !== "string" || !event.id)
        throw new Error("Runtime event id is required");
    if (typeof event.agentId !== "string" || !event.agentId)
        throw new Error("Runtime event agentId is required");
    if (typeof event.type !== "string" || !eventTypes.has(event.type))
        throw new Error("Unknown runtime event type");
    if (typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt)))
        throw new Error("Runtime event createdAt is invalid");
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload))
        throw new Error("Runtime event payload must be an object");
    return event;
}
export function stableProgressEventId(agentId, itemId, stream = "activity") {
    return `${stream}:${agentId}:${itemId}`;
}
