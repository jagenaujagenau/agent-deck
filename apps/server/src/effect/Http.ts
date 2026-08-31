import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { MESSAGE_ACTIONS } from "./CommandQueue";
import { isLoopback, pairingPage, pairingPayload } from "./Pairing";
import {
  AgentEventInput,
  ControlCommand,
  Heartbeat,
  ManagedSessionRequest,
  ManagedSessionTarget,
  PairingRequest,
  ResolveRequestBody,
  RuntimeEventEnvelope,
  SlashCommandPublication,
  type JsonValue,
} from "./Domain";
import { isMasterToken } from "./Auth";
import { BridgeConfig } from "./Config";
import { agentFingerprint } from "./Fingerprint";
import { ManagedRuntime } from "./Managed";
import { BridgeState, type PendingBlock } from "./State";
import { BRIDGE_VERSION } from "./Version";
import { BridgeStore } from "./Store";

/** Path prefix the phone, watch, and hooks are already built against. */
const BRIDGE_PREFIX = "/bridge/v1";

const param = (name: string) => Effect.map(HttpRouter.params, (params) => params[name] ?? "");

const error = (message: string, status: number) =>
  HttpServerResponse.json({ error: message }, { status });

/**
 * The one sentence a refused prompt carries, naming what the agent is
 * actually waiting on so the person steering can go answer it instead.
 */
export const blockedDetail = (block: PendingBlock): string =>
  block.kind === "approval"
    ? `The agent is waiting for approval to run ${block.tool}`
    : `The agent is waiting for an answer to: ${block.question}`;

/**
 * The prompt-shaped actions: the ones a blocked agent would silently queue.
 * Named by the queue that owns them, so "which actions are instructions" has
 * one answer rather than the four copies it used to have.
 */
const promptActions = MESSAGE_ACTIONS;

/**
 * The `wait` query as a parking window: how long a poller may be held open
 * for the answer to settle, in seconds, capped below every client timeout
 * so a parked response always beats the socket. Absent or unreadable means
 * answer now — which is also what an older bridge did with the parameter,
 * so a new adapter against an old bridge simply polls faster.
 */
const waitWindow = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const asked = Number(new URL(request.url, "http://bridge").searchParams.get("wait"));
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, 25) * 1_000 : 0;
});

/**
 * Parses a request body against the wire contract, so a handler receives a
 * domain value rather than something it has to inspect field by field.
 *
 * Decoding is deliberately permissive about what it ignores: unknown keys pass
 * through and an optional field may arrive absent or null, because the runtimes
 * are separate programs and the deployed bridge accepts both. What it will not
 * do is let an unparsed body reach a handler.
 */
const rawBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A body that is not JSON at all fails the same way as one that is the wrong
  // shape: both are a 400, never a 500.
  return yield* Effect.orElseSucceed(request.json, () => undefined);
});

const decodeBody = <S extends Schema.Top>(schema: S) =>
  Effect.flatMap(rawBody, Schema.decodeUnknownEffect(schema));

/** Answers 400 when a body does not fit its contract, keeping the deployed wording. */
const onMalformed =
  (message: string) =>
  <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Schema.SchemaError | E, R>) =>
    Effect.catchTag(effect, "SchemaError", () => error(message, 400));

/**
 * A route that answers only on the bridge's own machine.
 *
 * The gate rides the route rather than opening each handler, so a new
 * desk-only route cannot ship without it: the wrapper is how the route is
 * declared. `refusal` is the sentence this particular route refuses with —
 * the shape is shared, the words are not.
 */
const loopbackOnly =
  (refusal: string) =>
  <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isLoopback(Option.getOrUndefined(request.remoteAddress))) {
        return yield* error(refusal, 403);
      }
      return yield* handler;
    });

const route = <E, R>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => HttpRouter.route(method, `${BRIDGE_PREFIX}${path}`, handler);

/**
 * Every route this bridge serves, as data.
 *
 * The router is built from this array, so the inventory cannot drift from
 * what actually answers — `bridgeRoutePaths` reads it back and the contract
 * suite asserts that every route is documented and either exercised or
 * listed as knowingly untested. A route added without a doc line is a
 * failing test rather than something a reader has to notice.
 */
const bridgeRouteTable = [
  /**
   * Liveness and version, outside the versioned prefix and outside auth. The
   * service wrapper polls this to decide whether the bridge came up, and the
   * desktop app reads the version from it - neither has a credential to offer,
   * and a version is not a secret.
   */
  HttpRouter.route(
    "GET",
    "/",
    HttpServerResponse.json({ status: "ok", name: "agent-deck-bridge", version: BRIDGE_VERSION }),
  ),
  // ---- reads -------------------------------------------------------------
  route(
    "GET",
    "/snapshot",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* HttpServerResponse.json(yield* state.snapshot);
    }),
  ),
  route(
    "GET",
    "/agents/:agentId/history",
    Effect.gen(function* () {
      const store = yield* BridgeStore;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.url, "http://bridge").searchParams;
      const asked = Number(query.get("limit"));
      const limit = Number.isFinite(asked) && asked > 0 ? asked : undefined;
      // `before` pages backwards: pass the oldest createdAt the client already
      // holds to receive the window before it.
      const before = query.get("before") ?? undefined;
      return yield* HttpServerResponse.json({
        events: yield* store.history(yield* param("agentId"), limit, before),
      });
    }),
  ),
  route(
    "GET",
    "/agents/:agentId/changes",
    Effect.gen(function* () {
      const store = yield* BridgeStore;
      return yield* HttpServerResponse.json({
        changes: yield* store.fileChanges(yield* param("agentId")),
      });
    }),
  ),
  route(
    "GET",
    "/agents/:agentId/slash-commands",
    Effect.gen(function* () {
      const store = yield* BridgeStore;
      return yield* HttpServerResponse.json({
        commands: yield* store.slashCommands(yield* param("agentId")),
      });
    }),
  ),
  route(
    "GET",
    "/agents/:agentId/explain",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const explanation = yield* state.explain(yield* param("agentId"));
      return explanation === undefined
        ? yield* error("Agent not found", 404)
        : yield* HttpServerResponse.json(explanation);
    }),
  ),
  route(
    "GET",
    "/agents/:agentId/requests/:requestId",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const status = yield* state.requestStatus(
        yield* param("agentId"),
        yield* param("requestId"),
        yield* waitWindow,
      );
      return status === undefined
        ? yield* error("Request not found", 404)
        : yield* HttpServerResponse.json(status);
    }),
  ),
  route(
    "GET",
    "/agents/:id/commands",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const after = new URL(request.url, "http://bridge").searchParams.get("after") ?? undefined;
      return yield* HttpServerResponse.json({
        commands: yield* state.pendingCommands(yield* param("id"), after, yield* waitWindow),
      });
    }),
  ),
  /**
   * The dock's own reads and takes: what a person queued that the runtime
   * has not yet collected, and the withdrawal of one such instruction. A
   * device may cancel only what is still queued — a delivered instruction
   * cannot be unsaid, only followed up.
   */
  route(
    "GET",
    "/agents/:agentId/queued",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* HttpServerResponse.json({
        commands: yield* state.queuedMessages(yield* param("agentId")),
      });
    }),
  ),
  route(
    "DELETE",
    "/agents/:agentId/queued/:commandId",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return (yield* state.cancelCommand(yield* param("agentId"), yield* param("commandId")))
        ? yield* HttpServerResponse.json({ canceled: true })
        : yield* error("Nothing queued under that id — it may already be delivered", 404);
    }),
  ),
  route(
    "GET",
    "/commands/:id/receipt",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const receipt = yield* state.commandReceipt(yield* param("id"));
      return receipt === undefined
        ? yield* error("Command receipt not found", 404)
        : yield* HttpServerResponse.json({
            commandId: receipt.command_id,
            status: receipt.status,
            error: receipt.error,
            resultSequence: receipt.result_sequence,
            updatedAt: receipt.updated_at,
          });
    }),
  ),

  // ---- writes ------------------------------------------------------------
  route(
    "POST",
    "/agents/heartbeat",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* Effect.gen(function* () {
        const input = yield* decodeBody(Heartbeat);
        return yield* HttpServerResponse.json(yield* state.heartbeat(input), { status: 201 });
      }).pipe(onMalformed("id, name and state are required"));
    }),
  ),
  route(
    "POST",
    "/agents/:id/events",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* Effect.gen(function* () {
        const input = yield* decodeBody(AgentEventInput);
        const event = yield* state.addEvent(yield* param("id"), input);
        return event === undefined
          ? yield* error("Agent not found", 404)
          : yield* HttpServerResponse.json(event, { status: 201 });
      }).pipe(onMalformed("kind and summary are required"));
    }),
  ),
  route(
    "POST",
    "/agents/:id/runtime-events",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const raw = yield* rawBody;
      // Only the routing field is read here; ingestRuntimeEvent validates the
      // event itself and owns the vocabulary of what a runtime may say.
      const envelope = yield* Schema.decodeUnknownEffect(RuntimeEventEnvelope)(raw).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const id = yield* param("id");
      if (envelope?.agentId !== id)
        return yield* error("Runtime event agent does not match route", 400);
      // SAFETY: `raw` came out of the JSON body parser - the envelope decode
      // above just read a field from it - so it is a parsed JSON document.
      return yield* state.ingestRuntimeEvent(raw as JsonValue).pipe(
        Effect.flatMap((result) => HttpServerResponse.json(result, { status: 201 })),
        Effect.catchTag("InvalidRuntimeEvent", (failure) => error(failure.reason, 400)),
      );
    }),
  ),
  route(
    "POST",
    "/agents/:id/control",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* Effect.gen(function* () {
        const input = yield* decodeBody(ControlCommand);
        const id = yield* param("id");
        const support = yield* state.supportsControl(id, input.action);
        if (support === undefined) return yield* error("Agent not found", 404);
        if (!support) return yield* error(`This runtime does not support ${input.action}`, 409);
        // A prompt sent while the agent is blocked on an approval or question
        // queues silently behind it — the sender believes they steered when
        // nothing moved. Refused unless the sender said "queue anyway" with
        // `force`. approve/reject/stop/pause/resume are never refused here:
        // they are how a blocked agent gets unblocked.
        if (promptActions.includes(input.action) && input.force !== true) {
          const block = yield* state.pendingBlock(id);
          if (block !== undefined) {
            // "agent_blocked" is a wire contract: clients detect this refusal
            // by matching the error string, so it must never be reworded.
            return yield* HttpServerResponse.json(
              { error: "agent_blocked", detail: blockedDetail(block) },
              { status: 409 },
            );
          }
        }
        if (
          (input.action === "approve" || input.action === "reject") &&
          !(yield* state.hasPendingApproval(id))
        ) {
          return yield* error("No approval is currently pending", 409);
        }
        const command = yield* state.control(
          id,
          input.action,
          input.value ?? undefined,
          input.commandId ?? undefined,
        );
        // A bridge-hosted session acts on the command in process; a hook session
        // collects it by polling /commands.
        if (command)
          yield* Effect.forkDetach((yield* ManagedRuntime).handle(command).pipe(Effect.ignore));
        return command === undefined
          ? yield* error("Agent not found", 404)
          : yield* HttpServerResponse.json(command, { status: 202 });
      }).pipe(onMalformed("Invalid action"));
    }),
  ),
  /**
   * Dismisses a session from the deck. Its history, usage, and file changes
   * are kept — this declutters the live list, it does not erase what the
   * session did. A session still heartbeating simply reappears on its next
   * beat, which is the honest outcome: you cannot dismiss something that is
   * still running.
   */
  route(
    "DELETE",
    "/agents/:id",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const removed = yield* state.removeAgent(yield* param("id"));
      return removed
        ? yield* HttpServerResponse.json({ removed: true })
        : yield* error("Agent not found", 404);
    }),
  ),
  /**
   * A person looked at this session. Seen is shared across surfaces — the
   * phone marking a session viewed clears its "done" badge on the watch —
   * so it lives on the bridge, not in each app's local store. Deliberately
   * read-scoped: looking at a conversation is reading, not steering.
   */
  route(
    "POST",
    "/agents/:id/seen",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const viewedAt = yield* state.markViewed(yield* param("id"));
      return viewedAt === undefined
        ? yield* error("Agent not found", 404)
        : yield* HttpServerResponse.json({ viewedAt });
    }),
  ),
  route(
    "POST",
    "/agents/:id/commands/:commandId/ack",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const command = yield* state.acknowledge(yield* param("id"), yield* param("commandId"));
      return command === undefined
        ? yield* error("Command not found", 404)
        : yield* HttpServerResponse.json(command);
    }),
  ),
  route(
    "POST",
    "/agents/:agentId/slash-commands",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* Effect.gen(function* () {
        const input = yield* decodeBody(SlashCommandPublication);
        // SAFETY: the catalog was decoded from a JSON body; its entries stay
        // deliberately unconstrained, but they can only be JSON values.
        yield* state.setSlashCommands(
          yield* param("agentId"),
          input.commands.slice(0, 400) as Array<JsonValue>,
        );
        return yield* HttpServerResponse.json({ stored: input.commands.length });
      }).pipe(onMalformed("commands must be an array"));
    }),
  ),
  /**
   * Answers a pending request. Only the runtime credential may record an
   * outcome other than "answered" — a device answering a question is normal,
   * a device declaring a request unavailable is not.
   */
  route(
    "POST",
    "/agents/:agentId/requests/:requestId/resolve",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const config = yield* BridgeConfig;
      const input = yield* decodeBody(ResolveRequestBody).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (input === undefined) return yield* error("Invalid request status", 400);
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        input.status !== "answered" &&
        !isMasterToken(config.masterToken, request.headers["authorization"])
      ) {
        return yield* error("Only the runtime credential may resolve this request status", 403);
      }
      const managed = yield* ManagedRuntime;
      const agentId = yield* param("agentId");
      const requestId = yield* param("requestId");
      // SAFETY: the resolution value was decoded from a JSON body; the wire
      // leaves it opaque, but it can only be a JSON value.
      const value = input.value as JsonValue | undefined;
      // A bridge-hosted session is handed the answer directly; otherwise it is
      // recorded durably for a blocked runtime to collect.
      const resolved =
        (yield* managed.resolve(agentId, requestId, input.status, value)) ||
        (yield* state.resolveRuntimeRequest(agentId, requestId, input.status, value));
      return resolved
        ? yield* HttpServerResponse.json({ resolved: true })
        : yield* error("No pending request to resolve, or the resolution does not fit it", 404);
    }),
  ),

  /**
   * The models a hosted session will answer as, asked of the runtime rather
   * than compiled into a surface: a model shipped after the phone was
   * installed would be missing from any list the app carried, and a model
   * the account cannot reach would be offered by any list we wrote. A
   * session the bridge does not host answers 404 — a terminal session's
   * model belongs to the runtime that owns it.
   */
  route(
    "GET",
    "/agents/:agentId/models",
    Effect.gen(function* () {
      const managed = yield* ManagedRuntime;
      const models = yield* managed.models(yield* param("agentId"));
      return models === undefined
        ? yield* error("This session's model is the runtime's, not the bridge's", 404)
        : yield* HttpServerResponse.json({ models });
    }),
  ),
  route(
    "GET",
    "/managed/runtimes",
    Effect.gen(function* () {
      const managed = yield* ManagedRuntime;
      return yield* HttpServerResponse.json({ runtimes: yield* managed.available });
    }),
  ),
  route(
    "POST",
    "/managed/claude/sessions",
    Effect.gen(function* () {
      const managed = yield* ManagedRuntime;
      return yield* Effect.gen(function* () {
        const input = yield* decodeBody(ManagedSessionRequest);
        return yield* managed
          .start({
            project: input.project,
            cwd: input.cwd,
            model: input.model ?? undefined,
            objective: input.objective ?? undefined,
            prompt: input.prompt ?? undefined,
            permissionMode: input.permissionMode ?? undefined,
          })
          .pipe(
            Effect.flatMap((session) => HttpServerResponse.json(session, { status: 201 })),
            Effect.catchTag("ManagedStartError", (failure) => error(failure.message, 400)),
          );
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.gen(function* () {
            // Decoding failed; which half of the body was at fault decides what
            // to tell the caller.
            const target = yield* Schema.decodeUnknownEffect(ManagedSessionTarget)(
              yield* rawBody,
            ).pipe(Effect.orElseSucceed(() => undefined));
            return yield* target === undefined
              ? error("project and an absolute cwd are required", 400)
              : error("Invalid permissionMode", 400);
          }),
        ),
      );
    }),
  ),
  route(
    "POST",
    "/managed/:agentId/requests/:requestId/resolve",
    Effect.gen(function* () {
      const managed = yield* ManagedRuntime;
      const config = yield* BridgeConfig;
      const input = yield* decodeBody(ResolveRequestBody).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (input === undefined) return yield* error("Invalid request status", 400);
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        input.status !== "answered" &&
        !isMasterToken(config.masterToken, request.headers["authorization"])
      ) {
        return yield* error("Only the runtime credential may resolve this request status", 403);
      }
      // SAFETY: the resolution value was decoded from a JSON body; the wire
      // leaves it opaque, but it can only be a JSON value.
      const resolved = yield* managed.resolve(
        yield* param("agentId"),
        yield* param("requestId"),
        input.status,
        input.value as JsonValue | undefined,
      );
      return resolved
        ? yield* HttpServerResponse.json({ resolved: true })
        : yield* error("Managed session not found", 404);
    }),
  ),
  route(
    "GET",
    "/analytics",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.url, "http://bridge").searchParams;
      return yield* HttpServerResponse.json(
        yield* state.analytics(
          query.get("range") ?? "month",
          query.get("project") ?? undefined,
          query.get("timeZone") ?? "UTC",
        ),
      );
    }),
  ),
  route(
    "GET",
    "/diagnostics/projection-parity",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      return yield* HttpServerResponse.json({ agents: yield* state.projectionParity });
    }),
  ),
  // ---- the pairing surface ----------------------------------------------
  /**
   * The pairing page and its endpoints answer only to this machine. The trust
   * model has always been "whoever can read the log may pair" — the code is
   * printed there — and serving it to the LAN would widen that to "whoever
   * can reach the port". See Pairing.ts.
   */
  HttpRouter.route(
    "GET",
    "/pair",
    loopbackOnly("The pairing page answers only on the bridge's own machine")(
      Effect.gen(function* () {
        const config = yield* BridgeConfig;
        return HttpServerResponse.html(pairingPage(config.name));
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/pair/code",
    loopbackOnly("Pairing codes are minted only on the bridge's own machine")(
      Effect.gen(function* () {
        const config = yield* BridgeConfig;
        const state = yield* BridgeState;
        const minted = yield* state.createPairingCode;
        return yield* HttpServerResponse.json(
          pairingPayload(minted.code, minted.expiresAt, config.port, config.name),
        );
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/pair/devices",
    loopbackOnly("The device list answers only on the bridge's own machine")(
      Effect.gen(function* () {
        const state = yield* BridgeState;
        return yield* HttpServerResponse.json(yield* state.devices);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/pair/devices/:deviceId",
    loopbackOnly("Devices are revoked only on the bridge's own machine")(
      Effect.gen(function* () {
        const state = yield* BridgeState;
        return (yield* state.revokeDeviceById(yield* param("deviceId")))
          ? yield* HttpServerResponse.json({ revoked: true })
          : yield* error("Device not found", 404);
      }),
    ),
  ),

  /** Pairing is the one route that runs before a credential exists. */
  route(
    "POST",
    "/pair",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const input = yield* decodeBody(PairingRequest).pipe(Effect.orElseSucceed(() => undefined));
      // The shape is the schema's business; that a code is six digits is this
      // endpoint's own rule, so it stays visible here.
      if (input === undefined || !/^\d{6}$/.test(input.code) || !input.deviceName.trim()) {
        return yield* error("A six-digit code and device name are required", 400);
      }
      const device = yield* state.pair(input.code, input.deviceName.trim().slice(0, 80));
      return device === undefined
        ? yield* error("Pairing code is invalid or expired", 401)
        : yield* HttpServerResponse.json(device, { status: 201 });
    }),
  ),
  route(
    "DELETE",
    "/device",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      return (yield* state.revokeDevice(bearer))
        ? yield* HttpServerResponse.json({ revoked: true })
        : yield* error("Device token not found", 404);
    }),
  ),

  // ---- live stream -------------------------------------------------------
  /**
   * A snapshot is re-derived on every change, but most of it is unchanged: one
   * agent moving from running to idle used to resend every other session with
   * it. Each connection gets one full snapshot, then only the agents whose
   * rendered state actually differs from what that connection was last sent.
   */
  route(
    "GET",
    "/events",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      // Kept per connection because clients attach at different revisions and
      // must not depend on each other's position in the stream.
      let sent: Map<string, string> | undefined;
      const encoder = new TextEncoder();

      const frame = Effect.gen(function* () {
        const snapshot = yield* state.snapshot;
        const fingerprints = new Map<string, string>(
          snapshot.agents.map((agent): [string, string] => [
            String(agent.id),
            agentFingerprint(agent),
          ]),
        );
        const revision = String(snapshot.sequence);
        if (sent === undefined) {
          sent = fingerprints;
          return `event: snapshot\nid: ${revision}\ndata: ${JSON.stringify(snapshot)}\n\n`;
        }
        const agents = snapshot.agents.filter(
          (agent) => sent!.get(String(agent.id)) !== fingerprints.get(String(agent.id)),
        );
        const removed = [...sent.keys()].filter((id) => !fingerprints.has(id));
        sent = fingerprints;
        // A revision can bump without changing anything a device renders.
        if (agents.length === 0 && removed.length === 0) return undefined;
        const patch = {
          sequence: snapshot.sequence,
          bridge: snapshot.bridge,
          summary: snapshot.summary,
          agents,
          removed,
        };
        return `event: patch\nid: ${revision}\ndata: ${JSON.stringify(patch)}\n\n`;
      });

      const changes = SubscriptionRef.changes(state.revision).pipe(
        Stream.mapEffect(() => frame),
        Stream.filter((chunk): chunk is string => chunk !== undefined),
      );
      // A proxy that sees no bytes will drop an idle connection.
      const pings = Stream.tick("15 seconds").pipe(
        Stream.map(() => `event: ping\ndata: ${Date.now()}\n\n`),
      );

      return HttpServerResponse.stream(
        Stream.merge(changes, pings).pipe(Stream.map((chunk: string) => encoder.encode(chunk))),
        { contentType: "text/event-stream" },
      );
    }),
  ),
] as const;

export const BridgeRoutes = HttpRouter.addAll(bridgeRouteTable);

/** `METHOD /path` for every route, with the prefix each one actually carries. */
export const bridgeRoutePaths = (): ReadonlyArray<string> =>
  bridgeRouteTable.map((route) => `${route.method} ${route.path}`);
