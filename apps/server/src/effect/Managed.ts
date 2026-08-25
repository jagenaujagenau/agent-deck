import { stat } from "node:fs/promises";
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ClaudeSdkManagedRuntimeAdapter,
  type ManagedRequestStore,
  type ManagedSession,
  type RuntimeRequestStatus,
} from "@agent-control-dashboard/agent-adapter";
import type { AgentState } from "./Domain.ts";
import { BridgeState, type AgentRecord, type Command } from "./State.ts";

const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

export class ManagedStartError extends Schema.TaggedError<ManagedStartError>()(
  "ManagedStartError",
  {
    message: Schema.String,
  },
) {}

export interface StartInput {
  project: string;
  cwd: string;
  model?: string;
  objective?: string;
  prompt?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
}

interface Hosted {
  session: ManagedSession;
  agent: AgentRecord;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Sessions the bridge itself runs, as opposed to hook sessions that live in
 * their own process. The adapter streams canonical events; this turns them into
 * the same heartbeats and activity a hook session would post.
 */
export class ManagedRuntime extends Context.Service<
  ManagedRuntime,
  {
    readonly available: Effect.Effect<ReadonlyArray<Record<string, unknown>>>;
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<Record<string, unknown>, ManagedStartError>;
    readonly resolve: (
      agentId: string,
      requestId: string,
      status: RuntimeRequestStatus,
      value?: unknown,
    ) => Effect.Effect<boolean>;
    readonly handle: (command: Command) => Effect.Effect<boolean>;
  }
>()("agent-deck/server/ManagedRuntime") {
  static readonly layer = Layer.effect(
    ManagedRuntime,
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* Ref.make(new Map<string, Hosted>());
      // The adapter's callbacks are plain promises, so they step outside the
      // Effect runtime to call back in.
      const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

      /**
       * The adapter is callback-based and blocks a session until a request is
       * answered, so resolution is recorded durably and polled — the same path
       * a hook session uses.
       */
      const requests: ManagedRequestStore = {
        open: async (request) => {
          await run(
            Effect.gen(function* () {
              yield* sql`INSERT INTO bridge_requests (request_id, agent_id, kind, status, data, created_at, expires_at, resolved_at)
                       VALUES (${request.requestId}, ${request.agentId}, ${request.kind}, 'pending',
                               ${JSON.stringify(request.payload)}, ${request.createdAt}, ${request.expiresAt ?? null}, NULL)
                       ON CONFLICT(request_id) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind,
                         data = excluded.data, expires_at = excluded.expires_at`.pipe(Effect.orDie);
            }),
          );
        },
        resolve: async (requestId, status, value) => {
          await run(
            Effect.gen(function* () {
              const rows = yield* sql<{ agent_id: string }>`
              SELECT agent_id FROM bridge_requests WHERE request_id = ${requestId}`.pipe(
                Effect.orDie,
              );
              const agentId = rows[0]?.agent_id;
              if (agentId) yield* state.resolveRuntimeRequest(agentId, requestId, status, value);
            }),
          );
        },
        waitForResolution: async (requestId, signal) => {
          while (!signal.aborted) {
            const row = await run(
              Effect.gen(function* () {
                const rows = yield* sql<{
                  status: RuntimeRequestStatus;
                  data: string;
                  expires_at: string | null;
                }>`
                SELECT status, data, expires_at FROM bridge_requests WHERE request_id = ${requestId}`.pipe(
                  Effect.orDie,
                );
                return rows[0];
              }),
            );
            if (!row) throw new Error(`Managed request disappeared: ${requestId}`);
            if (row.status !== "pending") {
              let data: Record<string, unknown> = {};
              try {
                data = JSON.parse(row.data) as Record<string, unknown>;
              } catch {
                /* No resolution value. */
              }
              return { status: row.status, value: data.resolutionValue };
            }
            if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
              await run(
                Effect.gen(function* () {
                  yield* sql`UPDATE bridge_requests SET status = 'expired', resolved_at = ${now()}
                           WHERE request_id = ${requestId} AND status = 'pending'`.pipe(
                    Effect.orDie,
                  );
                }),
              );
              return { status: "expired" as const };
            }
            await Bun.sleep(250);
          }
          throw new Error("Managed request aborted");
        },
      };
      const adapter = new ClaudeSdkManagedRuntimeAdapter(requests);

      const available = Effect.sync(() => [
        { runtime: "claude", capabilities: adapter.capabilities, managed: true },
      ]);

      /** Turns one canonical event into the heartbeat and activity a card shows. */
      const consumeEvent = (agentId: string, hosted: Hosted, event: any) =>
        Effect.gen(function* () {
          yield* state.ingestRuntimeEvent(event).pipe(Effect.ignore);
          if (event.type === "session.state.changed" && typeof event.payload.state === "string") {
            hosted.agent.state = event.payload.state as AgentState;
            if (typeof event.payload.task === "string") hosted.agent.task = event.payload.task;
          }
          if (event.type === "turn.completed" && typeof event.payload.costUsd === "number") {
            hosted.agent.costUsd += event.payload.costUsd;
          }
          if (event.type === "token-usage.updated") {
            const usage = event.payload.usage as Record<string, unknown> | undefined;
            const num = (key: string) =>
              typeof usage?.[key] === "number" ? (usage[key] as number) : 0;
            const turnTokens =
              num("input_tokens") +
              num("cache_read_input_tokens") +
              num("cache_creation_input_tokens") +
              num("output_tokens");
            hosted.agent.tokens = turnTokens;
            hosted.agent.processedTokens = (hosted.agent.processedTokens ?? 0) + turnTokens;
          }
          if (event.type === "user-input.requested") {
            const questions = Array.isArray(event.payload.questions)
              ? (event.payload.questions as Array<Record<string, unknown>>)
              : [];
            const first = questions[0];
            // Only a single-answer question maps onto the device's option list.
            const options =
              questions.length === 1 && first?.multiSelect !== true && Array.isArray(first?.options)
                ? (first.options as Array<Record<string, unknown>>)
                    .map((option) => String(option.label ?? ""))
                    .filter(Boolean)
                : [];
            yield* state.addEvent(agentId, {
              id: event.requestId ?? event.id,
              kind: "question",
              summary: String(questions[0]?.question ?? "Claude needs your input"),
              options,
            });
          }
          if (
            event.type === "item.started" ||
            event.type === "item.completed" ||
            event.type === "runtime.error"
          ) {
            const kind =
              event.type === "runtime.error"
                ? "error"
                : event.payload.kind === "tool"
                  ? "tool"
                  : event.payload.kind === "reasoning"
                    ? "thought"
                    : "output";
            const summary =
              kind === "thought"
                ? "Reasoning"
                : typeof event.payload.text === "string"
                  ? event.payload.text.slice(0, 300)
                  : typeof event.payload.tool === "string"
                    ? `${event.payload.tool}`
                    : event.type === "runtime.error"
                      ? String(event.payload.message ?? "Runtime error")
                      : "Activity";
            const toolInput = event.payload.input as Record<string, unknown> | undefined;
            const detail =
              (kind === "output" || kind === "thought") && typeof event.payload.text === "string"
                ? event.payload.text
                : toolInput
                  ? JSON.stringify(toolInput, null, 2)
                  : undefined;
            yield* state.addEvent(agentId, {
              id: event.itemId ?? event.id,
              kind,
              summary,
              detail,
              tool: typeof event.payload.tool === "string" ? event.payload.tool : undefined,
              command: typeof toolInput?.command === "string" ? toolInput.command : undefined,
              path:
                typeof toolInput?.path === "string"
                  ? toolInput.path
                  : typeof toolInput?.file_path === "string"
                    ? toolInput.file_path
                    : undefined,
            });
          }
          yield* state.heartbeat(hosted.agent);
        });

      const consume = (agentId: string, session: ManagedSession) =>
        Effect.gen(function* () {
          const hosted = (yield* Ref.get(sessions)).get(agentId);
          if (hosted === undefined) return;
          yield* Stream.fromAsyncIterable(adapter.events(session), (cause) => cause).pipe(
            Stream.runForEach((event) => consumeEvent(agentId, hosted, event)),
          );
        });

      const start = Effect.fn("ManagedRuntime.start")(function* (input: StartInput) {
        if (!input.project?.trim() || !input.cwd?.startsWith("/")) {
          return yield* new ManagedStartError({
            message: "project and an absolute cwd are required",
          });
        }
        const directory = yield* Effect.promise(() => stat(input.cwd).catch(() => undefined));
        if (!directory?.isDirectory()) {
          return yield* new ManagedStartError({
            message: "cwd does not exist or is not a directory",
          });
        }
        const agentId = `managed-claude-${crypto.randomUUID()}`;
        const session = yield* Effect.tryPromise({
          try: () =>
            adapter.start({
              agentId,
              project: input.project.trim().slice(0, 120),
              cwd: input.cwd,
              model: input.model,
              permissionMode: input.permissionMode,
            }),
          catch: (cause) =>
            new ManagedStartError({
              message: cause instanceof Error ? cause.message : "Unable to start managed Claude",
            }),
        });
        // A session running without approval prompts cannot be approved from a
        // device, so it must not advertise the capability.
        const unattended = ["auto", "bypassPermissions", "dontAsk"].includes(
          input.permissionMode ?? "default",
        );
        const agent: AgentRecord = {
          id: agentId,
          name: "Managed Claude",
          project: session.project,
          model: session.model,
          runtime: "claude",
          runtimeProtocol: "canonical-v1",
          state: "idle",
          task: "Ready",
          objective: input.objective?.trim().slice(0, 500),
          tokens: 0,
          processedTokens: 0,
          costUsd: 0,
          lastSeenAt: now(),
          events: [],
          capabilities: [
            "pause",
            "stop",
            "prompt",
            "steer",
            "follow_up",
            ...(unattended ? [] : ["approve" as const, "reject" as const]),
          ],
        };
        yield* state.heartbeat(agent);
        // A managed session reports through the bridge's own clock: without
        // this it would be marked offline between turns.
        const timer = setInterval(() => void run(state.heartbeat(agent)), 15_000);
        yield* Ref.update(sessions, (map) => new Map(map).set(agentId, { session, agent, timer }));
        yield* Effect.forkDetach(consume(agentId, session).pipe(Effect.ignore));
        if (input.prompt?.trim()) {
          yield* Effect.tryPromise({
            try: () => adapter.send(session, input.prompt!.trim()),
            catch: (cause) =>
              new ManagedStartError({
                message:
                  cause instanceof Error ? cause.message : "Unable to send the initial prompt",
              }),
          });
        }
        return {
          agentId,
          providerSessionId: session.providerSessionId,
          project: session.project,
          model: session.model,
          permissionMode: input.permissionMode ?? "default",
        };
      });

      const canResolve = (agentId: string, requestId: string, status: RuntimeRequestStatus) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ kind: string; status: string }>`
            SELECT kind, status FROM bridge_requests
            WHERE request_id = ${requestId} AND agent_id = ${agentId}`.pipe(Effect.orDie);
          const row = rows[0];
          return (
            row?.status === "pending" &&
            (status !== "answered" || row.kind === "user-input") &&
            (!["approved", "rejected"].includes(status) || row.kind === "approval")
          );
        });

      const resolve = Effect.fn("ManagedRuntime.resolve")(function* (
        agentId: string,
        requestId: string,
        status: RuntimeRequestStatus,
        value?: unknown,
      ) {
        const hosted = (yield* Ref.get(sessions)).get(agentId);
        if (hosted === undefined || !(yield* canResolve(agentId, requestId, status))) return false;
        yield* Effect.promise(() =>
          adapter.resolveRequest(hosted.session, requestId, status, value),
        );
        return true;
      });

      const handle = Effect.fn("ManagedRuntime.handle")(function* (command: Command) {
        const hosted = (yield* Ref.get(sessions)).get(command.agentId);
        if (hosted === undefined) return false;
        const action = Effect.gen(function* () {
          if (["prompt", "steer", "follow_up"].includes(command.action) && command.value) {
            yield* Effect.promise(() => adapter.send(hosted.session, command.value!));
          } else if (command.action === "pause") {
            yield* Effect.promise(() => adapter.interrupt(hosted.session));
          } else if (command.action === "stop") {
            yield* Effect.promise(() => adapter.stop(hosted.session));
            clearInterval(hosted.timer);
            yield* Ref.update(sessions, (map) => {
              const next = new Map(map);
              next.delete(command.agentId);
              return next;
            });
          }
          // approve/reject decisions are already durable in bridge_requests;
          // the SDK callback polls that row.
          yield* state.acknowledge(command.agentId, command.id);
        });
        // A failed command is reported to the session rather than lost.
        yield* action.pipe(
          Effect.catchCause((cause) =>
            state
              .ingestRuntimeEvent({
                id: makeId(),
                agentId: command.agentId,
                type: "runtime.error",
                createdAt: now(),
                payload: { message: String(cause) },
              })
              .pipe(Effect.ignore),
          ),
        );
        return true;
      });

      return ManagedRuntime.of({ available, start, resolve, handle });
    }),
  );
}
