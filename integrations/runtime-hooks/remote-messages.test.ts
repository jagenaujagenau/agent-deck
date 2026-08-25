import { describe, expect, test } from "bun:test";
import type { RemoteCommand } from "../../packages/agent-adapter/src/index";
import {
  countQueuedMessages,
  promptContext,
  drainRemoteMessages,
  isRemoteMessage,
  queuedMessageNotice,
  stopHookDecision,
  stopHookReason,
} from "./remote-messages";

function queue(commands: RemoteCommand[], options: { failAck?: string } = {}) {
  const acked: string[] = [];
  return {
    acked,
    commands: async () => commands,
    acknowledge: async (_agentId: string, commandId: string) => {
      if (options.failAck === commandId) throw new Error("bridge unreachable");
      acked.push(commandId);
      return undefined;
    },
  };
}

const command = (over: Partial<RemoteCommand> = {}): RemoteCommand => ({
  id: "cmd-1",
  action: "steer",
  value: "check the tests too",
  createdAt: "2026-08-24T10:00:00Z",
  ...over,
});

describe("isRemoteMessage", () => {
  test("accepts the three text-carrying actions", () => {
    for (const action of ["prompt", "steer", "follow_up"] as const) {
      expect(isRemoteMessage(command({ action }))).toBe(true);
    }
  });

  test("ignores control decisions and empty text", () => {
    expect(isRemoteMessage(command({ action: "approve", value: undefined }))).toBe(false);
    expect(isRemoteMessage(command({ action: "stop" }))).toBe(false);
    expect(isRemoteMessage(command({ value: "   " }))).toBe(false);
    expect(isRemoteMessage(command({ value: undefined }))).toBe(false);
  });
});

describe("drainRemoteMessages", () => {
  test("delivers queued messages oldest first and acknowledges each", async () => {
    const q = queue([
      command({ id: "b", createdAt: "2026-08-24T10:00:02Z", value: "then run the linter" }),
      command({ id: "a", createdAt: "2026-08-24T10:00:01Z", value: "check the tests too" }),
    ]);

    expect(await drainRemoteMessages(q, "claude-1")).toEqual([
      "check the tests too",
      "then run the linter",
    ]);
    expect(q.acked).toEqual(["a", "b"]);
  });

  test("leaves approval decisions in the queue for the blocked tool call to find", async () => {
    const q = queue([
      command({ id: "approval", action: "approve", value: undefined }),
      command({ id: "message" }),
    ]);

    await drainRemoteMessages(q, "claude-1");
    expect(q.acked).toEqual(["message"]);
  });

  test("a failed acknowledgement holds the message back rather than delivering it unacked", async () => {
    const q = queue([command({ id: "stuck" })], { failAck: "stuck" });

    expect(await drainRemoteMessages(q, "claude-1")).toEqual([]);
    expect(q.acked).toEqual([]);
  });

  test("an empty queue is not an error", async () => {
    expect(await drainRemoteMessages(queue([]), "claude-1")).toEqual([]);
  });
});

describe("stop hook output", () => {
  test("a single message is delivered as the user's own words", () => {
    expect(stopHookReason(["check the tests too"])).toBe(
      "The user sent this from Agent Deck while you were working:\n\ncheck the tests too",
    );
  });

  test("several messages keep their order and stay individually readable", () => {
    const reason = stopHookReason(["first", "second"]);
    expect(reason).toContain("1. first");
    expect(reason).toContain("2. second");
    expect(reason.indexOf("1. first")).toBeLessThan(reason.indexOf("2. second"));
  });

  test("the decision matches the contract Claude Code reads to continue a session", () => {
    const decision = JSON.parse(stopHookDecision(["do the thing"]));
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("do the thing");
  });
});

describe("queued message reporting", () => {
  test("counts undelivered messages without acknowledging any", async () => {
    const q = queue([
      command({ id: "a" }),
      command({ id: "b", action: "prompt" }),
      command({ id: "approval", action: "approve", value: undefined }),
    ]);

    expect(await countQueuedMessages(q, "claude-1")).toBe(2);
    // Counting must never consume: the Stop hook is the only drain point.
    expect(q.acked).toEqual([]);
  });

  test("the notice says the message is waiting, not sent", () => {
    expect(queuedMessageNotice(1)).toBe("1 message queued · delivers at the next turn");
    expect(queuedMessageNotice(3)).toBe("3 messages queued · deliver at the next turn");
  });

  test("an empty queue produces no notice, so the real activity line shows through", () => {
    expect(queuedMessageNotice(0)).toBeUndefined();
    expect(queuedMessageNotice(-1)).toBeUndefined();
  });
});

describe("promptContext", () => {
  test("labels a single queued message as having arrived before the prompt", () => {
    const text = promptContext(["go for it"]);
    expect(text).toContain("before this prompt");
    expect(text).toContain("go for it");
  });

  test("numbers several, oldest first", () => {
    const text = promptContext(["first", "second"]);
    expect(text).toContain("oldest first");
    expect(text.indexOf("1. first")).toBeLessThan(text.indexOf("2. second"));
  });
});
