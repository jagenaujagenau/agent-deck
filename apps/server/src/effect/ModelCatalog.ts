import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { RuntimeModel } from "@agent-control-dashboard/agent-adapter";

/**
 * The models an account could reach, the last time a session was able to say.
 *
 * A running session answers this question directly — the SDK asks its own
 * query what it supports — but the moment a person most wants the answer is
 * before there is a session at all: the start sheet, choosing what to open.
 * There is nothing to ask then, which is why starting a session offered no
 * model choice while switching one did.
 *
 * So the catalog is remembered. What the deck offers at start is what this
 * account could actually reach the last time it looked, kept in SQL so a
 * restarted bridge still has an answer, and stamped so a stale one can say
 * how old it is rather than pretending to be current.
 */

// The shape a caller receives — `{runtime, models, learnedAt}` — is the wire
// contract's `ModelCatalogEntry`, declared once in bridge-client where every
// consumer already reads it from.

export interface ModelCatalogDeps {
  readonly sql: SqlClient.SqlClient;
  readonly now: () => string;
}

export const makeModelCatalog = (deps: ModelCatalogDeps) => {
  const { sql, now } = deps;

  /**
   * Records what a runtime just said it supports.
   *
   * An empty list is not recorded. A runtime that cannot answer — an older
   * CLI, a transport that refuses — yields nothing rather than a guess, and
   * writing that over a good catalog would turn one failed question into a
   * start sheet with no models in it.
   */
  const remember = Effect.fn("ModelCatalog.remember")(function* (
    runtime: string,
    models: ReadonlyArray<RuntimeModel>,
  ) {
    if (models.length === 0) return;
    yield* sql`INSERT INTO bridge_model_catalog (runtime, models, updated_at)
               VALUES (${runtime}, ${JSON.stringify(models)}, ${now()})
               ON CONFLICT(runtime) DO UPDATE SET models = excluded.models,
                 updated_at = excluded.updated_at`;
  }, Effect.orDie);

  /** Every runtime the deck has ever heard a model list from. */
  const known = Effect.fn("ModelCatalog.known")(function* () {
    const rows = yield* sql<{ runtime: string; models: string; updated_at: string }>`
      SELECT runtime, models, updated_at FROM bridge_model_catalog ORDER BY runtime`;
    return rows.flatMap((row) => {
      const models = parseModels(row.models);
      // A row that will not parse is a row from a future shape of this table;
      // it is skipped rather than crashing the start sheet that asked.
      return models === undefined
        ? []
        : [{ runtime: row.runtime, models, learnedAt: row.updated_at }];
    });
  }, Effect.orDie);

  return { remember, known };
};

/**
 * A stored catalog, decided by the schema rather than trusted — the column is
 * JSON the bridge wrote, but a column written by an older or newer shape of
 * this code is exactly what a decoder is for.
 */
const StoredModels = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    description: Schema.optional(Schema.String),
    resolvedModel: Schema.optional(Schema.String),
  }),
);

const decodeModels = Schema.decodeUnknownOption(StoredModels);

const parseModels = (raw: string): ReadonlyArray<RuntimeModel> | undefined => {
  const parsed = Option.getOrUndefined(parseJson(raw));
  if (parsed === undefined) return undefined;
  return Option.getOrUndefined(decodeModels(parsed));
};

const parseJson = (raw: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(raw));
  } catch {
    return Option.none();
  }
};
