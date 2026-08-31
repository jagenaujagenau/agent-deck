import { describe, expect, test } from "bun:test";
import { emptyRuntimeProjection } from "@agent-control-dashboard/agent-adapter";
import { explainAgent } from "./State";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

describe("explainAgent", () => {
  test("a live claim is the state's word, named and time-boxed", () => {
    const projection = {
      ...emptyRuntimeProjection("a1"),
      stateAuthority: { source: "herdr", expiresAt: new Date(NOW + 60_000).toISOString() },
    };
    const explanation = explainAgent({ runtimeProtocol: "canonical-v1" }, projection, NOW);
    expect(explanation.state).toEqual({
      source: "herdr",
      confidence: "claimed",
      authority: projection.stateAuthority,
    });
  });

  test("an expired claim decays to the event log's word", () => {
    const projection = {
      ...emptyRuntimeProjection("a1"),
      stateAuthority: { source: "herdr", expiresAt: new Date(NOW - 1).toISOString() },
    };
    expect(explainAgent({ runtimeProtocol: "canonical-v1" }, projection, NOW).state).toEqual({
      source: "runtime-events",
      confidence: "projected",
    });
  });

  test("identity is registered only when the runtime said who it is", () => {
    const registered = {
      ...emptyRuntimeProjection("a1"),
      identity: { name: "Pi", project: "deck", model: "gpt" },
    };
    expect(explainAgent({}, registered, NOW).identity).toEqual({
      source: "session.registered",
      confidence: "registered",
    });
    expect(explainAgent({}, emptyRuntimeProjection("a1"), NOW).identity).toEqual({
      source: "heartbeat",
      confidence: "reported",
    });
  });

  test("a session with no projection is the heartbeat's word alone", () => {
    const explanation = explainAgent({}, undefined, NOW);
    expect(explanation.state).toEqual({ source: "heartbeat", confidence: "reported" });
    expect(explanation.projectionSequence).toBeUndefined();
  });
});
