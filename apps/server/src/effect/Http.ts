import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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
} from "./Domain";
import { BridgeConfig } from "./Config";
import { agentFingerprint } from "./Fingerprint";
import { ManagedRuntime } from "./Managed";
import { BridgeState } from "./State";
import { BRIDGE_VERSION } from "./Version";
import { BridgeStore } from "./Store";

/** Path prefix the phone, watch, and hooks are already built against. */
const BRIDGE_PREFIX = "/bridge/v1";

const param = (name: string) => Effect.map(HttpRouter.params, (params) => params[name] ?? "");

const error = (message: string, status: number) =>
  HttpServerResponse.json({ error: message }, { status });

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

const route = <E, R>(
  method: "GET" | "POST",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => HttpRouter.route(method, `${BRIDGE_PREFIX}${path}`, handler);

export const BridgeRoutes = HttpRouter.addAll([
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
      const asked = Number(new URL(request.url, "http://bridge").searchParams.get("limit"));
      const limit = Number.isFinite(asked) && asked > 0 ? asked : undefined;
      return yield* HttpServerResponse.json({
        events: yield* store.history(yield* param("agentId"), limit),
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
    "/agents/:agentId/requests/:requestId",
    Effect.gen(function* () {
      const state = yield* BridgeState;
      const status = yield* state.requestStatus(yield* param("agentId"), yield* param("requestId"));
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
        commands: yield* state.pendingCommands(yield* param("id"), after),
      });
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
      return yield* state.ingestRuntimeEvent(raw).pipe(
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
        yield* state.setSlashCommands(yield* param("agentId"), input.commands.slice(0, 400));
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
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const isMaster = Option.match(config.masterToken, {
        onNone: () => false,
        onSome: (master) => bearer === master,
      });
      if (input.status !== "answered" && !isMaster) {
        return yield* error("Only the runtime credential may resolve this request status", 403);
      }
      const managed = yield* ManagedRuntime;
      const agentId = yield* param("agentId");
      const requestId = yield* param("requestId");
      // A bridge-hosted session is handed the answer directly; otherwise it is
      // recorded durably for a blocked runtime to collect.
      const resolved =
        (yield* managed.resolve(agentId, requestId, input.status, input.value)) ||
        (yield* state.resolveRuntimeRequest(agentId, requestId, input.status, input.value));
      return resolved
        ? yield* HttpServerResponse.json({ resolved: true })
        : yield* error("No pending request to resolve", 404);
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
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const isMaster = Option.match(config.masterToken, {
        onNone: () => false,
        onSome: (master) => bearer === master,
      });
      if (input.status !== "answered" && !isMaster) {
        return yield* error("Only the runtime credential may resolve this request status", 403);
      }
      const resolved = yield* managed.resolve(
        yield* param("agentId"),
        yield* param("requestId"),
        input.status,
        input.value,
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
  HttpRouter.route(
    "DELETE",
    `${BRIDGE_PREFIX}/device`,
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
        const snapshot = yield* state.snapshot as Effect.Effect<any>;
        const fingerprints = new Map<string, string>(
          snapshot.agents.map((agent: any) => [String(agent.id), agentFingerprint(agent)]),
        );
        const revision = String(snapshot.sequence);
        if (sent === undefined) {
          sent = fingerprints;
          return `event: snapshot\nid: ${revision}\ndata: ${JSON.stringify(snapshot)}\n\n`;
        }
        const agents = snapshot.agents.filter(
          (agent: any) => sent!.get(String(agent.id)) !== fingerprints.get(String(agent.id)),
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
]);
