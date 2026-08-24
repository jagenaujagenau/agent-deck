import { createContext } from "@agent-control-dashboard/api/context";
import { appRouter } from "@agent-control-dashboard/api/routers/index";
import { auth } from "@agent-control-dashboard/auth";
import { env } from "@agent-control-dashboard/env/server";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bridgeApi } from "./bridge";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

app.route("/bridge/v1", bridgeApi);

app.get("/", (c) => {
  return c.text("OK");
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
  idleTimeout: 60,
};
