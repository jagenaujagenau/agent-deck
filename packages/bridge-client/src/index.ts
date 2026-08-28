export { AgentBlockedError, BridgeClient, BridgeError } from "./client";
export type { BridgeClientOptions } from "./client";
export { applyPatch } from "./patch";
export { subscribeDeck } from "./stream";
export type { DeckSubscription, SubscribeOptions } from "./stream";
export { SseParser } from "./sse";
export type { SseFrame } from "./sse";
export {
  conversationEntries,
  mergeSessionEvents,
  reasoningEvents,
  terminalEvents,
} from "./events";
export type { ConversationEntry, ConversationRole } from "./events";
export { attentionPriority, latestActivityAt, seenCovers, sessionSeen } from "./attention";
export type * from "./types";
