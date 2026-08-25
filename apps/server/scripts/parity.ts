import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { BridgeStore } from "../src/effect/Store.ts";

const TOKEN = process.env.BRIDGE_TOKEN!;
const BASE = "http://127.0.0.1:3000/bridge/v1";
const get = async (path: string) => {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as any;
};

const program = Effect.gen(function* () {
  const store = yield* BridgeStore;
  const snap = yield* Effect.promise(() => get("/snapshot"));
  // Compare the agents most likely to exercise every path: the ones with the most activity.
  const ids: string[] = snap.agents.map((a: any) => a.id);
  let pass = 0,
    fail = 0;
  for (const id of ids) {
    for (const [label, live, mine] of [
      [
        "history",
        (yield* Effect.promise(() => get(`/agents/${id}/history`))).events,
        yield* store.history(id),
      ],
      [
        "changes",
        (yield* Effect.promise(() => get(`/agents/${id}/changes`))).changes,
        yield* store.fileChanges(id),
      ],
      [
        "commands",
        (yield* Effect.promise(() => get(`/agents/${id}/slash-commands`))).commands,
        yield* store.slashCommands(id),
      ],
    ] as Array<[string, any, any]>) {
      const a = JSON.stringify(live),
        b = JSON.stringify(mine);
      if (a === b) {
        pass++;
      } else {
        fail++;
        console.log(
          `MISMATCH ${label} ${id.slice(0, 8)}: live=${live?.length} mine=${mine?.length}`,
        );
        if (live?.length === mine?.length && live?.length) {
          const i = live.findIndex(
            (_: any, k: number) => JSON.stringify(live[k]) !== JSON.stringify(mine[k]),
          );
          console.log("  first differing index", i);
          console.log("  live:", JSON.stringify(live[i])?.slice(0, 300));
          console.log("  mine:", JSON.stringify(mine[i])?.slice(0, 300));
        }
      }
    }
  }
  console.log(`\nparity: ${pass} match, ${fail} mismatch (across ${ids.length} agents)`);
});

const SqlLive = SqliteClient.layer({ filename: process.env.DB! });
Effect.runPromise(
  program.pipe(Effect.provide(BridgeStore.layer.pipe(Layer.provide(SqlLive)))),
).catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
