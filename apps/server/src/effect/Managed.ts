import { stat } from "node:fs/promises";
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import {
  ClaudeSdkManagedRuntimeAdapter,
  parseUserInputRequest,
  type CanonicalRuntimeEvent,
  type ManagedRequestStore,
  type ManagedRuntimeCapabilities,
  type ManagedSession,
  type RuntimeModel,
  type RuntimeRequestStatus,
} from "@agent-control-dashboard/agent-adapter";
import type { AgentState, JsonObject, JsonValue } from "./Domain";
import { isMessageAction } from "./CommandQueue";
import { BridgeState, type AgentRecord, type Command } from "./State";

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

/** What /managed/runtimes advertises for one runtime the bridge can host. */
export interface ManagedRuntimeDescriptor {
  runtime: string;
  capabilities: ManagedRuntimeCapabilities;
  managed: boolean;
}

/** What a caller gets back once a hosted session is running. */
export interface StartedManagedSession {
  agentId: string;
  providerSessionId: string;
  project: string;
  model: string;
  permissionMode: NonNullable<StartInput["permissionMode"]>;
}

/**
 * The event vocabulary leaves payload fields open, so each consumer parses the
 * fields it renders - the same per-field tolerance the deployed bridge had,
 * where one malformed field never discarded the rest of an event.
 */
const decodeString = Schema.decodeUnknownOption(Schema.String);
const decodeNumber = Schema.decodeUnknownOption(Schema.Number);

/**
 * Sessions the bridge itself runs, as opposed to hook sessions that live in
 * their own process. The adapter streams canonical events; this turns them into
 * the same heartbeats and activity a hook session would post.
 */
export class ManagedRuntime extends Context.Service<
  ManagedRuntime,
  {
    readonly available: Effect.Effect<ReadonlyArray<ManagedRuntimeDescriptor>>;
    readonly start: (input: StartInput) => Effect.Effect<StartedManagedSession, ManagedStartError>;
    readonly resolve: (
      agentId: string,
      requestId: string,
      status: RuntimeRequestStatus,
      value?: JsonValue,
    ) => Effect.Effect<boolean>;
    readonly handle: (command: Command) => Effect.Effect<boolean>;
    /**
     * The models this hosted session will answer as, asked of the runtime.
     * Undefined for a session the bridge does not host — a hook session's
     * model belongs to the runtime that owns its terminal.
     */
    readonly models: (agentId: string) => Effect.Effect<ReadonlyArray<RuntimeModel> | undefined>;
  }
>()("agent-deck/server/ManagedRuntime") {
  static readonly layer = Layer.effect(
    ManagedRuntime,
    Effect.gen(function* () {
      const state = yield* BridgeState;
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
            state.requests.open(
              request.agentId,
              request.requestId,
              request.kind,
              request.payload,
              request.createdAt,
              request.expiresAt,
            ),
          );
        },
        resolve: async (requestId, status, value) => {
          await run(
            Effect.gen(function* () {
              const agentId = yield* state.requests.agentFor(requestId);
              if (agentId) {
                // SAFETY: the adapter hands back the resolution value it was
                // given, which arrived through a JSON body or a JSON column,
                // so it is a JSON value by construction.
                yield* state.requests.resolve(agentId, requestId, status, value as JsonValue);
              }
            }),
          );
        },
        waitForResolution: async (requestId, signal) => {
          const agentId = await run(state.requests.agentFor(requestId));
          while (!signal.aborted) {
            // Parked on the same revision bump as every other semantic wait;
            // expiry is the ledger's to settle on read, published as a
            // resolution fact like any other. Short windows keep the abort
            // signal honest — a cancelled session waits out at most one park.
            const standing = agentId
              ? await run(state.requestStatus(agentId, requestId, 5_000))
              : await run(state.requests.status(requestId));
            if (!standing) throw new Error(`Managed request disappeared: ${requestId}`);
            if (standing.status !== "pending") return standing;
          }
          throw new Error("Managed request aborted");
        },
      };
      const adapter = new ClaudeSdkManagedRuntimeAdapter(requests);

      const models = Effect.fn("ManagedRuntime.models")(function* (agentId: string) {
        const hosted = (yield* Ref.get(sessions)).get(agentId);
        if (hosted === undefined || !adapter.models) return undefined;
        return yield* Effect.promise(() => adapter.models!(hosted.session));
      });

      const available = Effect.sync(() => [
        { runtime: "claude", capabilities: adapter.capabilities, managed: true },
      ]);

      /** Turns one canonical event into the heartbeat and activity a card shows. */
      const consumeEvent = (agentId: string, hosted: Hosted, event: CanonicalRuntimeEvent) =>
        Effect.gen(function* () {
          yield* state.ingestRuntimeEvent(event).pipe(Effect.ignore);
          if (event.type === "session.state.changed") {
            const sessionState = Option.getOrUndefined(decodeString(event.payload.state));
            if (sessionState !== undefined) {
              // SAFETY: an adapter only publishes canonical session states;
              // this trusts that rather than validating, exactly as the
              // deployed bridge did.
              hosted.agent.state = sessionState as AgentState;
              const task = Option.getOrUndefined(decodeString(event.payload.task));
              if (task !== undefined) hosted.agent.task = task;
            }
          }
          if (event.type === "turn.completed") {
            const costUsd = Option.getOrUndefined(decodeNumber(event.payload.costUsd));
            if (costUsd !== undefined) hosted.agent.costUsd += costUsd;
          }
          if (event.type === "token-usage.updated") {
            // SAFETY: the adapter publishes `usage` as the SDK's token-usage
            // object; each field is still parsed before it is counted.
            const usage = event.payload.usage as JsonObject | undefined;
            const num = (key: string) => Option.getOrElse(decodeNumber(usage?.[key]), () => 0);
            const turnTokens =
              num("input_tokens") +
              num("cache_read_input_tokens") +
              num("cache_creation_input_tokens") +
              num("output_tokens");
            hosted.agent.tokens = turnTokens;
            hosted.agent.processedTokens = (hosted.agent.processedTokens ?? 0) + turnTokens;
          }
          if (event.type === "user-input.requested") {
            // The phrasing decode is shared with every other reader; only a
            // single-answer question maps onto the device's option list.
            const parsed = parseUserInputRequest(event.payload);
            yield* state.addEvent(agentId, {
              id: event.requestId ?? event.id,
              kind: "question",
              summary: parsed?.question ?? "Claude needs your input",
              options: parsed !== undefined && !parsed.multiSelect ? parsed.options : [],
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
            const text = Option.getOrUndefined(decodeString(event.payload.text));
            const tool = Option.getOrUndefined(decodeString(event.payload.tool));
            const summary =
              kind === "thought"
                ? "Reasoning"
                : text !== undefined
                  ? text.slice(0, 300)
                  : tool !== undefined
                    ? `${tool}`
                    : event.type === "runtime.error"
                      ? String(event.payload.message ?? "Runtime error")
                      : "Activity";
            // SAFETY: the adapter publishes `input` as the tool call's
            // argument object; the fields a card renders are parsed below.
            const toolInput = event.payload.input as JsonObject | undefined;
            const detail =
              (kind === "output" || kind === "thought") && text !== undefined
                ? text
                : toolInput
                  ? JSON.stringify(toolInput, null, 2)
                  : undefined;
            yield* state.addEvent(agentId, {
              id: event.itemId ?? event.id,
              kind,
              summary,
              detail,
              tool,
              command: Option.getOrUndefined(decodeString(toolInput?.command)),
              path:
                Option.getOrUndefined(decodeString(toolInput?.path)) ??
                Option.getOrUndefined(decodeString(toolInput?.file_path)),
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
            // Advertised only when the runtime can really do it: a control a
            // surface offers and the bridge then refuses is worse than one it
            // never offered.
            ...(adapter.capabilities.modelSwitch ? ["set_model" as const] : []),
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

      const resolve = Effect.fn("ManagedRuntime.resolve")(function* (
        agentId: string,
        requestId: string,
        status: RuntimeRequestStatus,
        value?: JsonValue,
      ) {
        const hosted = (yield* Ref.get(sessions)).get(agentId);
        if (
          hosted === undefined ||
          !(yield* state.requests.canResolve(agentId, requestId, status, value))
        ) {
          return false;
        }
        yield* Effect.promise(() =>
          adapter.resolveRequest(hosted.session, requestId, status, value),
        );
        return true;
      });

      const handle = Effect.fn("ManagedRuntime.handle")(function* (command: Command) {
        const hosted = (yield* Ref.get(sessions)).get(command.agentId);
        if (hosted === undefined) return false;
        const action = Effect.gen(function* () {
          if (isMessageAction(command.action) && command.value) {
            yield* Effect.promise(() => adapter.send(hosted.session, command.value!));
          } else if (command.action === "set_model" && command.value && adapter.setModel) {
            yield* Effect.promise(() => adapter.setModel!(hosted.session, command.value!));
            // The deck says what the runtime is running only once it has
            // accepted the switch; a refusal leaves the old model standing.
            // The hosted record is updated too, or the next heartbeat — which
            // sends the record, not the session — would put the old model back.
            hosted.agent.model = hosted.session.model;
            yield* state.heartbeat(hosted.agent);
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

      return ManagedRuntime.of({ available, start, resolve, handle, models });
    }),
  );
}
