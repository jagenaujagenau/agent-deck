import {
  canonicalRuntimeEvent,
  emptyRuntimeProjection,
  isJsonObject,
  isJsonString,
  projectRuntimeEvent,
  type CanonicalRuntimeEvent,
  type RuntimeProjection,
} from "@agent-control-dashboard/agent-adapter";
import { isStaleStateReport } from "./RuntimeEventLog";
import type { JsonObject, JsonValue } from "./Domain";

/**
 * The adapter conformance corpus, and what playing it means.
 *
 * `docs/bridge-v1.schema.json` says what a runtime event may look like.
 * Nothing said what a *sequence* of them must add up to — that a report the
 * publisher already superseded is dropped, that a claim outranks other
 * publishers until it expires, that a subagent finishing after its turn does
 * not put a session back to work. Those rules were learned one production
 * surprise at a time and lived only inside this repository's own adapters.
 *
 * The corpus states them as scenarios: events in, projection out. Two runners
 * play it — `AdapterConformance.test.ts` in process against the shipped
 * projector, and `scripts/conformance.ts` over HTTP against a running bridge,
 * which is the one a harness author outside this repository can use.
 */
export const CONFORMANCE_CORPUS_PATH = "packages/bridge-client/fixtures/adapter-conformance.json";

export interface ConformanceScenario {
  readonly case: string;
  readonly why: string;
  readonly events: ReadonlyArray<JsonObject>;
  /** Whether the bridge takes each event into its log; absent means all of them. */
  readonly accepted?: ReadonlyArray<boolean>;
  /** The projection fields this scenario is about. `null` means "must be absent". */
  readonly expect: JsonObject;
  /**
   * Set where the scenario describes a guard that only exists below the HTTP
   * surface. `POST /agents/:id/runtime-events` refuses a body whose agentId
   * does not match the route, so a live runner sees a 400 where the projector
   * sees an event it ignores — two true statements about the same rule at two
   * layers, and a runner that expected the projection would report a bridge
   * that is behaving correctly as broken.
   */
  readonly httpRefused?: boolean;
}

export interface ConformanceCorpus {
  readonly comment: string;
  /** The session every scenario's events name, and the one a runner registers. */
  readonly agentId: string;
  readonly scenarios: ReadonlyArray<ConformanceScenario>;
}

/** Reads the corpus, refusing a shape a runner would otherwise misreport as passing. */
export function readConformanceCorpus(text: string): ConformanceCorpus {
  // SAFETY: the corpus is this repository's own fixture and is parsed as JSON;
  // every field a runner reads is checked below before it is used.
  const parsed = JSON.parse(text) as JsonValue;
  if (!isJsonObject(parsed)) throw new Error("The conformance corpus is not a JSON object");
  const agentId = parsed.agentId;
  const scenarios = parsed.scenarios;
  if (!isJsonString(agentId)) throw new Error("The conformance corpus names no agentId");
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("The conformance corpus holds no scenarios");
  }
  return {
    comment: isJsonString(parsed.comment) ? parsed.comment : "",
    agentId,
    scenarios: scenarios.map(readScenario),
  };
}

function readScenario(value: JsonValue): ConformanceScenario {
  if (!isJsonObject(value)) throw new Error("A conformance scenario is not an object");
  const name = value.case;
  const events = value.events;
  const expect = value.expect;
  if (!isJsonString(name)) throw new Error("A conformance scenario has no case name");
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`"${name}" holds no events`);
  }
  if (!isJsonObject(expect)) throw new Error(`"${name}" expects nothing`);
  const accepted = value.accepted;
  return {
    case: name,
    why: isJsonString(value.why) ? value.why : "",
    events: events.map((event) => {
      if (!isJsonObject(event)) throw new Error(`"${name}" holds an event that is not an object`);
      return event;
    }),
    accepted: Array.isArray(accepted) ? accepted.map((taken) => taken === true) : undefined,
    expect,
    httpRefused: value.httpRefused === true,
  };
}

export interface ScenarioAddressing {
  /** The session the corpus names, replaced by the one a runner created. */
  readonly corpusAgentId: string;
  readonly agentId: string;
  /**
   * A prefix for request ids. Request ids are global to a bridge and a settled
   * one never reopens, so a runner playing the corpus twice against one bridge
   * must not reuse them — the second run's approval would arrive already
   * answered and block nothing.
   */
  readonly requestPrefix?: string;
  /**
   * When the scenario's first event happened, as milliseconds since the epoch.
   * The corpus dates its events absolutely so the fold is deterministic, but a
   * live bridge judges a claim's expiry against its own clock: replayed as
   * written, every lease in the corpus is hours dead before it is asserted on.
   * Passing a base time shifts the whole scenario, keeping the offsets that
   * carry its meaning.
   */
  readonly baseTimeMs?: number;
}

/** One scenario's events, addressed to the session a runner actually created. */
export function scenarioEvents(
  scenario: ConformanceScenario,
  addressing: ScenarioAddressing,
): ReadonlyArray<JsonObject> {
  const { corpusAgentId, agentId, requestPrefix, baseTimeMs } = addressing;
  const first = scenario.events
    .map((event) => (isJsonString(event.createdAt) ? Date.parse(event.createdAt) : Number.NaN))
    .filter((time) => Number.isFinite(time))
    .reduce((earliest, time) => Math.min(earliest, time), Number.POSITIVE_INFINITY);
  return scenario.events.map((event) => {
    const addressed: JsonObject = { ...event };
    if (event.agentId === corpusAgentId) addressed.agentId = agentId;
    if (requestPrefix !== undefined && isJsonString(event.requestId)) {
      addressed.requestId = `${requestPrefix}${event.requestId}`;
    }
    if (baseTimeMs !== undefined && isJsonString(event.createdAt) && Number.isFinite(first)) {
      addressed.createdAt = new Date(
        baseTimeMs + (Date.parse(event.createdAt) - first),
      ).toISOString();
    }
    return addressed;
  });
}

/** A scenario after the fold: where it left the session, and what was taken. */
export interface PlayedScenario {
  readonly projection: RuntimeProjection;
  readonly accepted: ReadonlyArray<boolean>;
}

/**
 * Folds a scenario the way the bridge does: the stale guard first, and only
 * what it accepts reaches the projection. A refused report still counts as a
 * successful exchange — it is dropped, not an error — which is why the corpus
 * records acceptance per event rather than treating a refusal as a failure.
 */
export function playScenario(scenario: ConformanceScenario, agentId: string): PlayedScenario {
  const seqs = new Map<string, number>();
  let projection = emptyRuntimeProjection(agentId);
  let sequence = 0;
  const accepted: boolean[] = [];
  for (const raw of scenario.events) {
    const event: CanonicalRuntimeEvent = canonicalRuntimeEvent(raw);
    if (isStaleStateReport(seqs, event)) {
      accepted.push(false);
      continue;
    }
    accepted.push(true);
    sequence += 1;
    projection = projectRuntimeEvent(projection, event, sequence);
  }
  return { projection, accepted };
}

/**
 * What a scenario expected but did not get, one sentence per disagreement.
 *
 * `only` narrows the comparison to the fields a runner can actually observe:
 * in process that is the whole projection, but over HTTP a snapshot exposes
 * state, task and the live claim and nothing else, and a runner that quietly
 * skipped the rest while reporting a pass would be worse than one that says so.
 */
export function conformanceFailures(
  scenario: ConformanceScenario,
  observed: JsonObject,
  accepted: ReadonlyArray<boolean>,
  only?: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const failures: string[] = [];
  const wanted = scenario.accepted;
  if (wanted !== undefined) {
    for (const [index, taken] of wanted.entries()) {
      if (accepted[index] !== taken) {
        failures.push(
          `event ${index + 1} should have been ${taken ? "accepted" : "refused as stale"}`,
        );
      }
    }
  }
  for (const [field, expected] of Object.entries(scenario.expect)) {
    if (only !== undefined && !only.includes(field)) continue;
    const actual = observed[field];
    if (expected === null) {
      if (actual !== undefined && actual !== null) {
        failures.push(`${field} should be absent, and is ${JSON.stringify(actual)}`);
      }
      continue;
    }
    if (!matches(expected, actual)) {
      failures.push(
        `${field} should be ${JSON.stringify(expected)}, and is ${JSON.stringify(actual)}`,
      );
    }
  }
  return failures;
}

/**
 * Expectations are partial on purpose: a scenario about a claim names the
 * claim's source and says nothing about the timestamp beside it, so an object
 * is matched field by field and an array member by member.
 */
function matches(expected: JsonValue, actual: JsonValue | undefined): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((member, index) => matches(member, actual[index]));
  }
  if (isJsonObject(expected)) {
    if (actual === undefined || !isJsonObject(actual)) return false;
    return Object.entries(expected).every(([field, value]) => matches(value, actual[field]));
  }
  return expected === actual;
}

/** A projection as JSON, which is how both runners compare it. */
export function projectionFields(projection: RuntimeProjection): JsonObject {
  // SAFETY: the projection is a record of strings, numbers, and plain objects
  // built from JSON payloads — it is stored by round-tripping through JSON.
  return JSON.parse(JSON.stringify(projection)) as JsonObject;
}
