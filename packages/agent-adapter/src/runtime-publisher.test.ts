import { describe, expect, test } from "bun:test";
import type { CanonicalRuntimeEvent } from "./runtime-events";
import { canonicalRuntimeEvent } from "./runtime-events";
import { createRuntimePublisher } from "./runtime-publisher";

const collect = () => {
  const sent: CanonicalRuntimeEvent[] = [];
  const publish = createRuntimePublisher({
    source: "test-source",
    send: (event) => {
      sent.push(event);
      return Promise.resolve();
    },
  });
  return { sent, publish };
};

describe("createRuntimePublisher", () => {
  test("stamps origin with the source and an ascending per-agent sequence", async () => {
    const { sent, publish } = collect();
    await publish("agent-1", "session.state.changed", { state: "running", task: "t" });
    await publish("agent-1", "session.state.changed", { state: "idle", task: "t" });
    await publish("agent-2", "session.state.changed", { state: "running", task: "t" });
    expect(sent.map((event) => event.origin?.source)).toEqual([
      "test-source",
      "test-source",
      "test-source",
    ]);
    const [first, second] = sent;
    expect(second!.origin!.seq).toBeGreaterThan(first!.origin!.seq);
    // A restarted publisher must keep ascending, so sequences start at the clock.
    expect(first!.origin!.seq).toBeGreaterThanOrEqual(Date.parse("2026-01-01"));
  });

  test("an explicit seq is used verbatim, for orders that live outside the process", async () => {
    const { sent, publish } = collect();
    await publish("agent-1", "session.state.changed", { state: "idle" }, { seq: 7 });
    expect(sent[0]!.origin).toEqual({ source: "test-source", seq: 7 });
  });

  test("a caller's stable id survives, and an absent one is generated", async () => {
    const { sent, publish } = collect();
    await publish("agent-1", "user-input.resolved", { status: "answered" }, { id: "stable-1" });
    // The old OpenCode closure spread refs after id, so an explicit undefined
    // clobbered the generated id. The publisher must not.
    await publish("agent-1", "user-input.resolved", { status: "answered" }, { id: undefined });
    expect(sent[0]!.id).toBe("stable-1");
    expect(sent[1]!.id).toBeTruthy();
  });

  test("absent facts are omitted rather than sent, and refs only appear when given", async () => {
    const { sent, publish } = collect();
    await publish(
      "agent-1",
      "item.completed",
      { tool: "Bash", detail: undefined },
      { turnId: "turn-1" },
    );
    expect(sent[0]!.payload).toEqual({ tool: "Bash" });
    expect(sent[0]!.turnId).toBe("turn-1");
    expect("itemId" in sent[0]!).toBe(false);
    expect("requestId" in sent[0]!).toBe(false);
  });

  test("every published event passes the bridge's own validation", async () => {
    const { sent, publish } = collect();
    await publish("agent-1", "turn.started", { objective: "do the thing" }, { turnId: "turn-1" });
    const accepted = canonicalRuntimeEvent(JSON.parse(JSON.stringify(sent[0])));
    expect(accepted.origin).toEqual(sent[0]!.origin);
  });

  test("a send failure propagates, and the next report still advances", async () => {
    const sent: CanonicalRuntimeEvent[] = [];
    let fail = true;
    const publish = createRuntimePublisher({
      source: "test-source",
      send: (event) => {
        if (fail) return Promise.reject(new Error("bridge down"));
        sent.push(event);
        return Promise.resolve();
      },
    });
    await expect(publish("agent-1", "runtime.error", { message: "x" })).rejects.toThrow(
      "bridge down",
    );
    fail = false;
    await publish("agent-1", "runtime.error", { message: "x" });
    expect(sent).toHaveLength(1);
  });
});
