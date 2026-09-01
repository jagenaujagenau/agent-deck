import { SchemaRepresentation, type Schema } from "effect";
import { isJsonObject, isJsonString } from "@agent-control-dashboard/agent-adapter";
import {
  AgentEvent,
  AgentEventInput,
  ControlCommand,
  Heartbeat,
  ManagedSessionRequest,
  PairingRequest,
  ResolveRequestBody,
  RuntimeEvent,
  SlashCommandPublication,
  type JsonObject,
  type JsonValue,
} from "./Domain";

/**
 * The `/bridge/v1` payloads, as JSON Schema, derived from the schemas the
 * routes decode with.
 *
 * `docs/bridge-api.md` is the contract a person reads; this is the one a
 * program reads. A harness written in Rust or Go or Python cannot import the
 * TypeScript, and until this existed its author had to transcribe field lists
 * out of prose and hope. Generated rather than written, because a
 * hand-maintained spec beside a hand-maintained document is the copy that
 * rots: `WireSchema.test.ts` regenerates and compares, so the committed file
 * cannot fall behind the code that enforces it.
 *
 * What is deliberately not here: the snapshot and patch frames of `GET
 * /events`. Those are assembled from stored rows rather than decoded through a
 * schema, so there is nothing to derive and a hand-written description of them
 * would be exactly the drifting artifact this avoids.
 */
const payloads = [
  {
    name: "Heartbeat",
    schema: Heartbeat,
    description:
      "POST /agents/heartbeat — identity and liveness. Repeating totals is safe: usage is stored as deltas against a high-water cursor.",
  },
  {
    name: "AgentEventInput",
    schema: AgentEventInput,
    description:
      "POST /agents/:id/events — one event for a session's stream. The bridge assigns id and createdAt when they are omitted.",
  },
  {
    name: "RuntimeEvent",
    schema: RuntimeEvent,
    description:
      'POST /agents/:id/runtime-events — the canonical vocabulary, for adapters that declare runtimeProtocol "canonical-v1". A session.state.changed may carry origin {source, seq}; reports whose sequence is not newer than the last accepted from that source are answered 201 {accepted: false, reason: "stale"}. Unknown fields are carried, not refused.',
  },
  {
    name: "ControlCommand",
    schema: ControlCommand,
    description:
      'POST /agents/:id/control — steer a session or resolve what it is blocked on. A prompt sent while the agent is blocked is refused with error "agent_blocked" unless force is set.',
  },
  {
    name: "ResolveRequestBody",
    schema: ResolveRequestBody,
    description:
      'POST /agents/:agentId/requests/:requestId/resolve — settle a durable approval or question. "pending" is absent on purpose: reopening a settled request is not something the wire allows.',
  },
  {
    name: "SlashCommandPublication",
    schema: SlashCommandPublication,
    description:
      "POST /agents/:agentId/slash-commands — the session's runnable catalog, capped at 400. Entries stay unconstrained: each runtime describes its own commands.",
  },
  {
    name: "ManagedSessionRequest",
    schema: ManagedSessionRequest,
    description: "POST /managed/claude/sessions — start a session the bridge itself hosts.",
  },
  {
    name: "PairingRequest",
    schema: PairingRequest,
    description:
      "POST /pair — exchange a short-lived single-use pairing code for a device credential. The only route that takes no bearer token.",
  },
  {
    name: "AgentEvent",
    schema: AgentEvent,
    description:
      "An event as the bridge hands it back: the input shape with id and createdAt filled in. Referenced from Heartbeat and returned in snapshots.",
  },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly schema: Schema.Top;
  readonly description: string;
}>;

/** Where the generated document lives, relative to the repository root. */
export const WIRE_SCHEMA_PATH = "docs/bridge-v1.schema.json";

/** The document `docs/bridge-v1.schema.json` holds. */
export function wireSchemaDocument(): JsonObject {
  // Named so each payload lands in `$defs` under the name this repository
  // calls it. A schema that already carries the identifier is used as it
  // stands: annotating it again would mint a second, identical definition
  // beside the first ("AgentEvent" and "AgentEvent_1").
  const asts = payloads.map((payload) =>
    identifierOf(payload.schema) === payload.name
      ? payload.schema.ast
      : payload.schema.annotate({ identifier: payload.name }).ast,
  );
  // SAFETY: `payloads` is a non-empty literal, so the mapped list is non-empty
  // too — which is all this assertion tells the compiler.
  const multi = SchemaRepresentation.toRepresentations(
    asts as [(typeof asts)[number], ...typeof asts],
  );
  // `additionalProperties: true` is the truth about this bridge rather than a
  // convenience: routes decode with Effect's default, which discards excess
  // properties instead of refusing them. Emitting `false` would tell a harness
  // author their heartbeat is invalid while the bridge happily accepts it.
  const emitted = SchemaRepresentation.toJsonSchemaMultiDocument(multi, {
    additionalProperties: true,
  });
  const definitions: Record<string, JsonValue> = {};
  for (const [name, schema] of Object.entries(emitted.definitions)) {
    // SAFETY: a JSON Schema document is JSON by construction — this one is
    // about to be written out with JSON.stringify.
    definitions[name] = simplify(schema as JsonValue);
  }
  for (const payload of payloads) {
    const definition = definitions[payload.name];
    if (definition !== undefined && isJsonObject(definition)) {
      definitions[payload.name] = { description: payload.description, ...definition };
    }
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/jagenaujagenau/agent-deck/blob/main/docs/bridge-v1.schema.json",
    title: "Agent Deck bridge — /bridge/v1 request payloads",
    description:
      "Generated from apps/server/src/effect/Domain.ts by apps/server/scripts/wire-schema.ts. Do not edit by hand. The prose contract is docs/bridge-api.md.",
    $defs: definitions,
  };
}

/** The name a schema already answers to, where it has one. */
function identifierOf(schema: Schema.Top): string | undefined {
  // SAFETY: annotations are a plain metadata bag; only `identifier` is read
  // here, and it is checked to be a string before it is used as one.
  const annotations = schema.ast.annotations as { readonly identifier?: JsonValue } | undefined;
  const identifier = annotations?.identifier;
  return identifier !== undefined && isJsonString(identifier) ? identifier : undefined;
}

/**
 * Collapses the nesting an optional-and-nullable field emits.
 *
 * A field written `Schema.optional(Schema.NullOr(String))` — which most of
 * this wire is, because adapters disagree about omitting versus sending null —
 * comes out as an anyOf wrapping an anyOf wrapping two branches, one of them
 * `null` twice over. Flattening and de-duplicating says the same thing in a
 * form a reader can follow.
 */
function simplify(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(simplify);
  if (!isJsonObject(value)) return value;
  const result: JsonObject = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = simplify(inner);
  }
  const branches = result.anyOf;
  if (!Array.isArray(branches)) return result;
  const flattened: JsonValue[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    const nested =
      isJsonObject(branch) && Array.isArray(branch.anyOf) && Object.keys(branch).length === 1
        ? branch.anyOf
        : [branch];
    for (const member of nested) {
      const written = JSON.stringify(member);
      if (seen.has(written)) continue;
      seen.add(written);
      flattened.push(member);
    }
  }
  // A one-branch anyOf is the branch itself.
  const only = flattened[0];
  if (only !== undefined && flattened.length === 1 && Object.keys(result).length === 1) return only;
  result.anyOf = flattened;
  return result;
}
