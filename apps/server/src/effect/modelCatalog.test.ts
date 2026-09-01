import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlClient } from "effect/unstable/sql";
import { makeModelCatalog } from "./ModelCatalog";
import { BridgeSchema } from "./Schema";

/**
 * What the deck can offer before there is a session to ask.
 */

const withCatalog = <A>(
  body: (
    catalog: ReturnType<typeof makeModelCatalog>,
    // A test may reach the database directly — one of these writes a row this
    // code cannot read, which is not something the catalog itself can do.
  ) => Effect.Effect<A, never, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* body(makeModelCatalog({ sql, now: () => new Date().toISOString() }));
  }).pipe(
    Effect.provide(BridgeSchema),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.runPromise,
  );

const sonnet = { id: "claude-sonnet-5", label: "Sonnet 5" };
const opus = { id: "claude-opus-5", label: "Opus 5", description: "The big one" };

describe("the model catalog", () => {
  test("what a runtime said is what the deck offers", async () => {
    const known = await withCatalog((catalog) =>
      Effect.gen(function* () {
        yield* catalog.remember("claude", [sonnet, opus]);
        return yield* catalog.known();
      }),
    );
    expect(known).toHaveLength(1);
    expect(known[0]?.runtime).toBe("claude");
    expect(known[0]?.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(known[0]?.models[1]?.description).toBe("The big one");
    expect(known[0]?.learnedAt).toBeTruthy();
  });

  test("a later answer replaces the one before it", async () => {
    const known = await withCatalog((catalog) =>
      Effect.gen(function* () {
        yield* catalog.remember("claude", [sonnet, opus]);
        // A model retired upstream must stop being offered, so the newest
        // answer is the whole answer rather than being merged into the old.
        yield* catalog.remember("claude", [opus]);
        return yield* catalog.known();
      }),
    );
    expect(known[0]?.models.map((model) => model.id)).toEqual(["claude-opus-5"]);
  });

  test("a runtime that cannot answer does not erase what it said before", async () => {
    // An older CLI, or a transport that refuses, yields an empty list rather
    // than a guess. Writing that over a good catalog would turn one failed
    // question into a start sheet with no models in it.
    const known = await withCatalog((catalog) =>
      Effect.gen(function* () {
        yield* catalog.remember("claude", [sonnet]);
        yield* catalog.remember("claude", []);
        return yield* catalog.known();
      }),
    );
    expect(known[0]?.models).toHaveLength(1);
  });

  test("runtimes are remembered apart", async () => {
    const known = await withCatalog((catalog) =>
      Effect.gen(function* () {
        yield* catalog.remember("claude", [sonnet]);
        yield* catalog.remember("codex", [{ id: "gpt-5", label: "GPT-5" }]);
        return yield* catalog.known();
      }),
    );
    expect(known.map((entry) => entry.runtime)).toEqual(["claude", "codex"]);
  });

  test("nothing learned is an empty catalog, not a failure", async () => {
    expect(await withCatalog((catalog) => catalog.known())).toEqual([]);
  });

  test("a row this code cannot read is skipped rather than crashing the sheet", async () => {
    const known = await withCatalog((catalog) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* catalog.remember("claude", [sonnet]);
        // A row from some future shape of this table.
        yield* sql`INSERT INTO bridge_model_catalog (runtime, models, updated_at)
                   VALUES ('mystery', '{"shape":"unknown"}', '2026-01-01T00:00:00.000Z')`.pipe(
          Effect.orDie,
        );
        return yield* catalog.known();
      }),
    );
    expect(known.map((entry) => entry.runtime)).toEqual(["claude"]);
  });
});
