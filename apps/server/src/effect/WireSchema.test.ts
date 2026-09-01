import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  canonicalRuntimeEvent,
  isJsonObject,
  type CanonicalRuntimeEvent,
} from "@agent-control-dashboard/agent-adapter";
import { RuntimeEvent, type JsonObject, type JsonValue } from "./Domain";
import { WIRE_SCHEMA_PATH, wireSchemaDocument } from "./WireSchema";

/** The published file, as the JSON it is. */
const committed = (): JsonObject => {
  // SAFETY: JSON.parse produces the JSON grammar, and this file is a JSON
  // object — the test below fails loudly if it is ever anything else.
  const document = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../..", WIRE_SCHEMA_PATH), "utf8"),
  ) as JsonValue;
  if (!isJsonObject(document)) throw new Error(`${WIRE_SCHEMA_PATH} is not a JSON object`);
  return document;
};

/** Its `$defs`, which every test here reads. */
const definitions = (): JsonObject => {
  const defs = committed().$defs;
  if (!isJsonObject(defs)) throw new Error(`${WIRE_SCHEMA_PATH} has no $defs`);
  return defs;
};

describe("the published wire schema", () => {
  test("matches what the schemas the routes decode with generate", () => {
    // The whole point of generating it: a wire shape changed in Domain.ts and
    // a published contract that still describes the old one is worse than no
    // published contract at all. Run `bun run schema` to settle this.
    expect(wireSchemaDocument()).toEqual(committed());
  });

  test("names every payload a client or adapter posts", () => {
    const defs = definitions();
    for (const name of [
      "Heartbeat",
      "AgentEventInput",
      "RuntimeEvent",
      "ControlCommand",
      "ResolveRequestBody",
      "SlashCommandPublication",
      "ManagedSessionRequest",
      "PairingRequest",
    ]) {
      expect(defs[name]).toBeDefined();
    }
  });

  test("every reference it makes resolves inside it", () => {
    const names = new Set(Object.keys(definitions()));
    const refs: JsonValue[] = [];
    const walk = (value: JsonValue): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!isJsonObject(value)) return;
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref") refs.push(inner);
        else walk(inner);
      }
    };
    walk(committed());
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(names.has(String(ref).replace("#/$defs/", ""))).toBe(true);
      expect(String(ref).startsWith("#/$defs/")).toBe(true);
    }
  });

  test("says extra properties are allowed, because the bridge allows them", () => {
    // Routes decode with Effect's default, which drops excess properties
    // rather than refusing them. A schema saying otherwise would fail traffic
    // this bridge accepts today.
    const heartbeat = definitions().Heartbeat;
    expect(isJsonObject(heartbeat) && heartbeat.additionalProperties).toBe(true);
  });
});

/**
 * The published `RuntimeEvent` and the `canonicalRuntimeEvent` ingester are
 * two statements of one rule, and only the ingester is enforced at runtime.
 * These hold them to the same verdicts on the cases that matter, so the
 * contract a harness author builds against is the contract the bridge keeps.
 */
describe("the published runtime event and the ingester that enforces it", () => {
  /** What a value looks like once it has been JSON and back — i.e. on the wire. */
  const roundTrip = (value: JsonObject | CanonicalRuntimeEvent): JsonObject => {
    // SAFETY: every case here is a literal object of JSON values, so its
    // serialisation parses back to a JSON object.
    const parsed = JSON.parse(JSON.stringify(value)) as JsonValue;
    if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
    return parsed;
  };

  const valid = Schema.is(RuntimeEvent);
  const accepted = (value: JsonValue) => {
    try {
      canonicalRuntimeEvent(value);
      return true;
    } catch {
      return false;
    }
  };

  const wellFormed: JsonObject = {
    id: "e1",
    agentId: "a1",
    type: "session.state.changed",
    createdAt: "2026-09-01T10:00:00Z",
    payload: { state: "running" },
    origin: { source: "hook", seq: 4 },
  };

  test("both accept a well-formed event", () => {
    // Without this the agreement cases below would also pass if the schema
    // and the ingester rejected everything alike.
    expect(valid(wellFormed)).toBe(true);
    expect(accepted(wellFormed)).toBe(true);
  });

  /** The same event with one field left out, as an adapter that never set it sends. */
  const without = (field: string): JsonObject => {
    const event = { ...wellFormed };
    delete event[field];
    return event;
  };

  const cases: ReadonlyArray<[string, JsonObject]> = [
    ["a well-formed state report", wellFormed],
    ["one with no origin", without("origin")],
    ["one with the optional ids", { ...wellFormed, turnId: "t1", itemId: "i1", requestId: "r1" }],
    ["an empty id", { ...wellFormed, id: "" }],
    ["an empty agentId", { ...wellFormed, agentId: "" }],
    ["an unknown type", { ...wellFormed, type: "session.exploded" }],
    ["a missing payload", without("payload")],
    ["a payload that is not an object", { ...wellFormed, payload: "running" }],
    ["an origin with no source", { ...wellFormed, origin: { seq: 1 } }],
  ];

  for (const [name, value] of cases) {
    test(name, () => {
      // Round-tripped so an `undefined` field is absent, exactly as it would
      // be after crossing the wire.
      const input = roundTrip(value);
      // An origin that cannot be ordered is dropped rather than refused — the
      // fact the event carries is still true — so the ingester accepts what
      // the schema rejects in that one case, and only that one.
      const lenient = name === "an origin with no source";
      expect(accepted(input)).toBe(lenient ? true : valid(input));
    });
  }

  test("a malformed origin is dropped, not kept", () => {
    const event = canonicalRuntimeEvent({ ...wellFormed, origin: { seq: 1 } });
    expect(event.origin).toBeUndefined();
    expect(valid(roundTrip(event))).toBe(true);
  });

  test("unknown fields ride along, and the schema allows them", () => {
    const event = roundTrip(canonicalRuntimeEvent({ ...wellFormed, vendorField: "kept" }));
    expect(event.vendorField).toBe("kept");
    expect(valid(event)).toBe(true);
  });
});
