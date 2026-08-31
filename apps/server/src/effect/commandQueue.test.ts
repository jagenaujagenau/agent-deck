import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlClient } from "effect/unstable/sql";
import { makeCommandQueue, isMessageAction, MESSAGE_ACTIONS } from "./CommandQueue";
import { BridgeSchema } from "./Schema";
import type { Command } from "./State";

/**
 * The Command lifecycle, driven directly.
 *
 * Before the queue was its own module these rules could only be reached by
 * spawning a bridge and speaking HTTP to it — so "a delivered instruction
 * cannot be withdrawn" was proved by a subprocess and a raw fetch. The
 * interface is the test surface now: an in-memory database, the same two
 * tables, and the rules asked directly.
 */

const at = (seconds: number) => `2026-08-31T12:00:${String(seconds).padStart(2, "0")}.000Z`;

/** The queue over a private in-memory database, with the facts it publishes recorded. */
const withQueue = <A>(
  body: (queue: ReturnType<typeof makeCommandQueue>, deliveries: string[]) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deliveries: string[] = [];
    const commands = yield* Ref.make(new Map<string, Command>());
    const queue = makeCommandQueue(
      {
        sql,
        now: () => at(0),
        recordDelivery: (agentId, commandId) =>
          Effect.sync(() => {
            deliveries.push(`${agentId}:${commandId}`);
            return deliveries.length;
          }),
        changed: Effect.void,
      },
      commands,
    );
    return yield* body(queue, deliveries);
  }).pipe(
    Effect.provide(BridgeSchema),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.runPromise,
  );

const command = (id: string, overrides: Partial<Command> = {}): Command => ({
  id,
  agentId: "a1",
  action: "prompt",
  value: "do the thing",
  createdAt: at(1),
  ...overrides,
});

describe("the command queue", () => {
  test("a queued command is collectable, and its receipt opens queued", async () => {
    const [pending, receipt] = await withQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.queue(command("c1"));
        return [yield* queue.pendingFor("a1"), yield* queue.receipt("c1")] as const;
      }),
    );
    expect(pending.map((entry) => entry.id)).toEqual(["c1"]);
    expect(receipt?.status).toBe("queued");
  });

  test("acknowledging hands it to the runtime, and the receipt says delivered", async () => {
    const [pending, receipt, deliveries] = await withQueue((queue, deliveries) =>
      Effect.gen(function* () {
        yield* queue.queue(command("c1"));
        yield* queue.acknowledge("a1", "c1");
        return [yield* queue.pendingFor("a1"), yield* queue.receipt("c1"), deliveries] as const;
      }),
    );
    // Collected means no longer pending: a runtime polling again must not
    // find the instruction it already took.
    expect(pending).toEqual([]);
    expect(receipt?.status).toBe("delivered");
    expect(receipt?.result_sequence).toBe(1);
    expect(deliveries).toEqual(["a1:c1"]);
  });

  test("a queued instruction is the sender's to take back, until it is not", async () => {
    const [withdrawn, tooLate, receipt] = await withQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.queue(command("c1"));
        yield* queue.queue(command("c2"));
        const withdrawn = yield* queue.cancel("a1", "c1");
        yield* queue.acknowledge("a1", "c2");
        // A delivered instruction cannot be unsaid, only followed up.
        const tooLate = yield* queue.cancel("a1", "c2");
        return [withdrawn, tooLate, yield* queue.receipt("c1")] as const;
      }),
    );
    expect(withdrawn).toBe(true);
    expect(tooLate).toBe(false);
    expect(receipt?.status).toBe("canceled");
  });

  test("a command belongs to its own session and nobody else's", async () => {
    const [wrongAgent, wrongCancel] = await withQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.queue(command("c1"));
        return [
          yield* queue.acknowledge("someone-else", "c1"),
          yield* queue.cancel("someone-else", "c1"),
        ] as const;
      }),
    );
    expect(wrongAgent).toBeUndefined();
    expect(wrongCancel).toBe(false);
  });

  test("only instructions are in the dock, oldest first", async () => {
    const queued = await withQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.queue(command("later", { createdAt: at(9) }));
        yield* queue.queue(command("earlier", { createdAt: at(2) }));
        // A decision is not something a person queued to say.
        yield* queue.queue(command("decision", { action: "approve", value: undefined }));
        return yield* queue.queuedMessages("a1");
      }),
    );
    expect(queued.map((entry) => entry.id)).toEqual(["earlier", "later"]);
  });

  test("a retried request finds the command it already queued", async () => {
    const [first, retried] = await withQueue((queue) =>
      Effect.gen(function* () {
        const first = yield* queue.queue(command("same-id"));
        return [first, yield* queue.existing("same-id")] as const;
      }),
    );
    expect(retried?.id).toBe(first.id);
    expect(await withQueue((queue) => queue.existing(undefined))).toBeUndefined();
  });

  test("the instruction-shaped actions are named once", () => {
    expect(MESSAGE_ACTIONS).toEqual(["prompt", "steer", "follow_up"]);
    expect(isMessageAction("steer")).toBe(true);
    expect(isMessageAction("approve")).toBe(false);
    expect(isMessageAction("set_model")).toBe(false);
  });
});
