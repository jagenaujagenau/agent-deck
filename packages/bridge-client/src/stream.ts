import { applyPatch } from "./patch";
import { SseParser } from "./sse";
import type { BridgeSnapshot, BridgeSnapshotPatch } from "./types";

export interface DeckSubscription {
  /** Closes the stream and stops reconnecting. */
  close(): void;
}

export interface SubscribeOptions {
  /** Called with the full deck after every change — the first call is the initial snapshot. */
  onSnapshot: (snapshot: BridgeSnapshot) => void;
  /** Called when a connection attempt or an open stream fails; reconnection is automatic. */
  onError?: (error: Error) => void;
  /** Base delay before a reconnect, doubled per consecutive failure. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  fetcher?: typeof fetch;
}

const DEFAULT_RECONNECT_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

/**
 * The live deck: connects to `GET /events`, applies snapshot and patch frames,
 * and hands the caller a full `BridgeSnapshot` after every change. Frames are
 * per-connection, so each reconnect starts from a fresh snapshot; `ping`
 * frames are consumed silently.
 */
export function subscribeDeck(
  baseUrl: string,
  token: string,
  options: SubscribeOptions,
): DeckSubscription {
  const controller = new AbortController();
  const fetcher = options.fetcher ?? fetch;
  const base = baseUrl.replace(/\/+$/, "");
  let attempt = 0;
  // The Snapshot Sequence guard every surface carries (ConnectionPolicy.kt,
  // ConnectionPolicy.swift, WearSnapshotPolicy.kt): a client never applies a
  // lower sequence over a higher one. Held across reconnects — a fresh
  // connection replaying an older deck must not roll back what the caller
  // has already been shown.
  let lastSequence = 0;

  const run = async () => {
    while (!controller.signal.aborted) {
      let current: BridgeSnapshot | undefined;
      try {
        const response = await fetcher(`${base}/bridge/v1/events`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          throw new Error(`Event stream returned ${response.status}`);
        }
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if (frame.event === "snapshot") {
              // SAFETY: the contract states the snapshot frame's data is a
              // BridgeSnapshot; the bridge is the authority on the shape.
              const snapshot = JSON.parse(frame.data) as BridgeSnapshot;
              attempt = 0;
              if (snapshot.sequence >= lastSequence) {
                lastSequence = snapshot.sequence;
                current = snapshot;
                options.onSnapshot(current);
              }
            } else if (frame.event === "patch" && current !== undefined) {
              // SAFETY: same contract, patch frame.
              const patch = JSON.parse(frame.data) as BridgeSnapshotPatch;
              if (patch.sequence >= lastSequence) {
                lastSequence = patch.sequence;
                current = applyPatch(current, patch);
                options.onSnapshot(current);
              }
            }
            // ping frames keep proxies awake and mean nothing here.
          }
        }
        // A server closing cleanly is still a connection to re-establish.
        throw new Error("Event stream ended");
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      attempt += 1;
      const backoff = Math.min(
        (options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS) * 2 ** (attempt - 1),
        options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  };

  void run();
  return { close: () => controller.abort() };
}
