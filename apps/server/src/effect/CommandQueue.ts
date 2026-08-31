import { Effect, Ref } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { Command } from "./State";

/**
 * The one owner of queued Commands (`bridge_commands`) and their receipts
 * (`bridge_command_receipts`).
 *
 * A Command's whole life is here: queued when a device asks, collected when
 * the runtime polls, acknowledged when it takes delivery, withdrawn while it
 * is still nobody's but the sender's. Before this module the lifecycle was
 * spread through BridgeState with the receipt vocabulary written as three
 * raw SQL string literals — `'queued'`, `'delivered'`, `'canceled'` — in
 * three different functions, so nothing said what a receipt's states were or
 * which transitions were legal, and `cancelCommand` had to re-derive
 * "acknowledged means it is theirs now" as a local condition.
 *
 * What stays outside: `control`'s mutation of the session record. Queuing a
 * command and deciding that a paused agent is now paused are two facts, and
 * only the first is the queue's.
 */

/** How a Command settled, as the receipt records it. */
export type ReceiptStatus = "queued" | "delivered" | "canceled";

/**
 * The instruction-shaped actions — the ones a person can still take back,
 * and the ones a blocked session would silently swallow. Written once here
 * rather than as a literal array in four places.
 */
export const MESSAGE_ACTIONS: ReadonlyArray<string> = ["prompt", "steer", "follow_up"];

export const isMessageAction = (action: string): boolean => MESSAGE_ACTIONS.includes(action);

/** A receipt row, as a device reads it back. */
export interface CommandReceiptRow {
  command_id: string;
  status: string;
  error: string | null;
  result_sequence: number | null;
  updated_at: string;
}

export interface CommandQueueDeps {
  readonly sql: SqlClient.SqlClient;
  readonly now: () => string;
  /** Publishes the delivery fact, answering with the sequence it landed at. */
  readonly recordDelivery: (agentId: string, commandId: string) => Effect.Effect<number>;
  /** Wakes every SSE subscriber; the queue changed what a surface would render. */
  readonly changed: Effect.Effect<void>;
}

export const makeCommandQueue = (
  deps: CommandQueueDeps,
  commandsRef: Ref.Ref<Map<string, Command>>,
) => {
  const { sql, now, recordDelivery, changed } = deps;

  const persist = (command: Command) =>
    sql`INSERT INTO bridge_commands (id, agent_id, data, updated_at)
        VALUES (${command.id}, ${command.agentId}, ${JSON.stringify(command)}, ${now()})
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`.pipe(
      Effect.orDie,
    );

  const writeReceipt = (commandId: string, status: ReceiptStatus) =>
    sql`INSERT OR REPLACE INTO bridge_command_receipts (command_id, status, updated_at)
        VALUES (${commandId}, ${status}, ${now()})`.pipe(Effect.orDie);

  /**
   * The Command a retry names, if it has already been queued. A retried
   * request must never queue a second action, so this is asked before
   * anything is written.
   */
  const existing = Effect.fn("CommandQueue.existing")(function* (commandId: string | undefined) {
    if (commandId === undefined) return undefined;
    return (yield* Ref.get(commandsRef)).get(commandId);
  });

  /** Queues a Command and opens its receipt. */
  const queue = Effect.fn("CommandQueue.queue")(function* (command: Command) {
    yield* Ref.update(commandsRef, (map) => new Map(map).set(command.id, command));
    yield* persist(command);
    yield* writeReceipt(command.id, "queued");
    return command;
  });

  /** What this session has queued and uncollected, newest last. */
  const pendingFor = Effect.fn("CommandQueue.pendingFor")(function* (
    agentId: string,
    after?: string,
  ) {
    const afterTime = after ? Date.parse(after) : 0;
    const commands = yield* Ref.get(commandsRef);
    return [...commands.values()].filter(
      (command) =>
        command.agentId === agentId &&
        !command.acknowledgedAt &&
        Date.parse(command.createdAt) > afterTime,
    );
  });

  /** The message Commands still waiting to be collected, oldest first. */
  const queuedMessages = Effect.fn("CommandQueue.queuedMessages")(function* (agentId: string) {
    const commands = yield* Ref.get(commandsRef);
    return [...commands.values()]
      .filter(
        (command) =>
          command.agentId === agentId && !command.acknowledgedAt && isMessageAction(command.action),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  /** The runtime has taken delivery: the Command is theirs, and the receipt says so. */
  const acknowledge = Effect.fn("CommandQueue.acknowledge")(function* (
    agentId: string,
    commandId: string,
  ) {
    const commands = yield* Ref.get(commandsRef);
    const command = commands.get(commandId);
    if (command === undefined || command.agentId !== agentId) return undefined;
    const delivered: Command = { ...command, acknowledgedAt: now() };
    yield* Ref.update(commandsRef, (map) => new Map(map).set(commandId, delivered));
    yield* persist(delivered);
    const sequence = yield* recordDelivery(agentId, commandId);
    yield* sql`UPDATE bridge_command_receipts SET status = 'delivered', result_sequence = ${sequence},
                 updated_at = ${now()} WHERE command_id = ${commandId}`.pipe(Effect.orDie);
    yield* changed;
    return delivered;
  });

  /**
   * Withdraws a queued Command. False once the runtime has acknowledged it —
   * a delivered instruction cannot be unsaid, only followed up.
   */
  const cancel = Effect.fn("CommandQueue.cancel")(function* (agentId: string, commandId: string) {
    const commands = yield* Ref.get(commandsRef);
    const command = commands.get(commandId);
    if (command === undefined || command.agentId !== agentId || command.acknowledgedAt) {
      return false;
    }
    yield* Ref.update(commandsRef, (map) => {
      const next = new Map(map);
      next.delete(commandId);
      return next;
    });
    yield* sql`DELETE FROM bridge_commands WHERE id = ${commandId}`.pipe(Effect.orDie);
    yield* sql`UPDATE bridge_command_receipts SET status = 'canceled', updated_at = ${now()}
               WHERE command_id = ${commandId}`.pipe(Effect.orDie);
    yield* changed;
    return true;
  });

  const receipt = Effect.fn("CommandQueue.receipt")(function* (commandId: string) {
    const rows = yield* sql<CommandReceiptRow>`
      SELECT command_id, status, error, result_sequence, updated_at
      FROM bridge_command_receipts WHERE command_id = ${commandId}`;
    return rows[0];
  }, Effect.orDie);

  return { existing, queue, pendingFor, queuedMessages, acknowledge, cancel, receipt };
};
