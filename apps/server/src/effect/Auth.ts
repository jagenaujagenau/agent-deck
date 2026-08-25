import { createHash } from "node:crypto";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BridgeConfig } from "./Config.ts";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export type Scope = "read" | "control";

/**
 * Which credential a path accepts.
 *
 * These rules are reproduced from the deployed bridge exactly, including the
 * regexes: they decide whether a paired phone may reach an endpoint, so a
 * "tidier" formulation here would be a silent change in who can call what.
 */
export const routePolicy = (method: string, path: string) => {
  const managedResolution = /^\/managed\/[^/]+\/requests\/[^/]+\/resolve$/.test(path);
  const requestResolution = /^\/agents\/[^/]+\/requests\/[^/]+\/resolve$/.test(path);
  // Reading a request's outcome is how a blocked runtime collects its answer — runtime credential
  // only. Writing the answer is a device action, so it takes the same control scope as approvals.
  const requestPolling = /^\/agents\/[^/]+\/requests\/[^/]+$/.test(path);
  const catalogPublish = method === "POST" && /^\/agents\/[^/]+\/slash-commands$/.test(path);
  const runtimeOnly =
    (path.startsWith("/managed/") && !managedResolution) ||
    requestPolling ||
    catalogPublish ||
    /\/agents\/heartbeat$|\/agents\/[^/]+\/(events|runtime-events|commands)(\/|$)/.test(path);
  const requiredScope: Scope =
    path.endsWith("/control") || managedResolution || requestResolution ? "control" : "read";
  return { runtimeOnly, requiredScope };
};

export const bearerOf = (header: string | undefined) => header?.replace(/^Bearer\s+/i, "") ?? "";

export class Authorizer extends Context.Service<
  Authorizer,
  {
    /** Whether this credential may take `method path`. */
    readonly authorize: (
      method: string,
      path: string,
      header: string | undefined,
    ) => Effect.Effect<boolean>;
    /** True when refusal is on; when false an unauthorized call still proceeds. */
    readonly enforcing: boolean;
  }
>()("agent-deck/server/Authorizer") {
  static readonly layer = Layer.effect(
    Authorizer,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* BridgeConfig;

      const authorizeDevice = Effect.fn("Authorizer.device")(function* (
        token: string,
        scope: Scope,
      ) {
        const rows = yield* sql<{ id: string; scopes: string }>`
          SELECT id, scopes FROM bridge_devices
          WHERE token_hash = ${tokenHash(token)} AND revoked_at IS NULL`;
        const device = rows[0];
        if (device === undefined || !device.scopes.split(",").includes(scope)) return false;
        yield* sql`UPDATE bridge_devices SET last_seen_at = ${new Date().toISOString()} WHERE id = ${device.id}`;
        return true;
      }, Effect.orDie);

      const authorize = Effect.fn("Authorizer.authorize")(function* (
        method: string,
        path: string,
        header: string | undefined,
      ) {
        const bearer = bearerOf(header);
        const isMaster = Option.match(config.masterToken, {
          onNone: () => false,
          onSome: (master) => bearer === master,
        });
        if (isMaster) return true;
        const { runtimeOnly, requiredScope } = routePolicy(method, path);
        if (runtimeOnly || bearer === "") return false;
        return yield* authorizeDevice(bearer, requiredScope);
      });

      return Authorizer.of({ authorize, enforcing: config.requireAuth });
    }),
  );
}
