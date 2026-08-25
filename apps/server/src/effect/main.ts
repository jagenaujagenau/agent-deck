import { Effect, Layer } from "effect";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Authorizer } from "./Auth";
import { BridgeConfig } from "./Config";
import { BridgeRoutes } from "./Http";
import { ManagedRuntime } from "./Managed";
import { BridgeSchema } from "./Schema";
import { BridgeState } from "./State";
import { BridgeStore } from "./Store";

/**
 * Refusal happens once, in front of every route, so a new route cannot
 * accidentally ship unauthenticated.
 */
const AuthMiddleware = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const auth = yield* Authorizer;
    yield* router.addGlobalMiddleware((httpApp) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The full path, prefix included — the deployed bridge matches against
        // Hono's `c.req.path`, which is not prefix-stripped. Several of its
        // anchored rules therefore never fire; see routePolicy.
        const path = new URL(request.url, "http://bridge").pathname;
        // Pairing is how a device obtains a credential; it cannot present one,
        // and liveness is polled by the service wrapper, which has none either.
        if (path === "/" || path.endsWith("/pair")) return yield* httpApp;
        const allowed = yield* auth.authorize(
          request.method,
          path,
          request.headers["authorization"],
        );
        if (!allowed && auth.enforcing) {
          return yield* HttpServerResponse.json(
            { error: "Pair this device or provide a valid bridge token" },
            { status: 401 },
          );
        }
        return yield* httpApp;
      }),
    );
  }),
);

const MainLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* BridgeConfig;
    const Sql = SqliteClient.layer({ filename: config.databaseUrl });
    return HttpRouter.serve(Layer.merge(BridgeRoutes, AuthMiddleware)).pipe(
      Layer.provide([ManagedRuntime.layer, BridgeStore.layer, Authorizer.layer]),
      Layer.provide(BridgeState.layer),
      // The schema is built before anything reads it, so a bridge handed an
      // empty database file still comes up.
      Layer.provide(BridgeSchema),
      Layer.provide(Sql),
      Layer.provide(BunHttpServer.layer({ port: config.port })),
    );
  }),
);

Layer.launch(MainLayer).pipe(BunRuntime.runMain);
