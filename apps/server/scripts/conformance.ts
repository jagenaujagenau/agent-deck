#!/usr/bin/env bun
/**
 * Plays the adapter conformance corpus against a running bridge.
 *
 * `docs/bridge-api.md` describes the protocol and
 * `docs/bridge-v1.schema.json` describes its payloads; neither can be run.
 * This can. Point it at a scratch bridge — never your real one, it creates and
 * drives sessions — and it reports, rule by rule, whether that bridge behaves
 * the way an adapter is entitled to expect:
 *
 *   BRIDGE_URL=http://127.0.0.1:3100 BRIDGE_TOKEN=… bun run conformance
 *
 * Two halves. The corpus scenarios are posted as runtime events and the
 * resulting session read back from the snapshot — which exposes state, task
 * and the live claim, so those are the fields checked here and the rest are
 * reported as unobserved rather than quietly passed. Then the exchanges no
 * sequence of events can express: the refusal a blocked session answers a
 * prompt with, and delivering a queued command at most once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFORMANCE_CORPUS_PATH,
  conformanceFailures,
  readConformanceCorpus,
  scenarioEvents,
} from "../src/effect/AdapterConformance";
import { isJsonObject, isJsonString } from "@agent-control-dashboard/agent-adapter";
import type { JsonObject, JsonValue } from "../src/effect/Domain";

const base = `${process.env.BRIDGE_URL ?? "http://127.0.0.1:3100"}/bridge/v1`;
const token = process.env.BRIDGE_TOKEN ?? "";
/** Every session this run creates wears it, so a scratch bridge can be swept. */
const RUN = `conformance-${Date.now().toString(36)}`;

const corpus = readConformanceCorpus(
  readFileSync(join(import.meta.dir, "../../..", CONFORMANCE_CORPUS_PATH), "utf8"),
);

/** The projection fields a snapshot actually exposes. */
const OBSERVABLE = ["state", "task", "stateAuthority"];

interface Answer {
  readonly status: number;
  readonly payload: JsonValue;
}

async function call(method: string, path: string, body?: JsonValue): Promise<Answer> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(base + path, init);
  const text = await response.text();
  // SAFETY: every bridge route answers JSON, and a body that is not JSON is
  // reported as the failure it is rather than parsed into a false pass.
  const payload = text ? (JSON.parse(text) as JsonValue) : null;
  return { status: response.status, payload };
}

/** One field of a JSON answer, or undefined where the answer was not an object. */
function field(value: JsonValue | undefined, name: string): JsonValue | undefined {
  return value !== undefined && isJsonObject(value) ? value[name] : undefined;
}

/** The agent the snapshot currently holds under this id. */
async function snapshotAgent(agentId: string): Promise<JsonObject> {
  const { payload } = await call("GET", "/snapshot");
  const agents = field(payload, "agents");
  const found = Array.isArray(agents)
    ? agents.find((agent) => field(agent, "id") === agentId)
    : undefined;
  if (found === undefined || !isJsonObject(found)) {
    throw new Error(`the bridge has no session ${agentId}`);
  }
  return found;
}

/** A session for one scenario to drive, announced the way an adapter announces one. */
async function register(agentId: string): Promise<void> {
  const { status } = await call("POST", "/agents/heartbeat", {
    id: agentId,
    name: `Conformance · ${agentId}`,
    project: "conformance",
    model: "conformance",
    runtime: "conformance",
    runtimeProtocol: "canonical-v1",
    state: "idle",
    task: "Ready",
    tokens: 0,
    costUsd: 0,
    capabilities: ["approve", "reject", "prompt", "stop"],
  });
  if (status >= 300) throw new Error(`heartbeat refused with ${status}`);
}

interface Result {
  readonly name: string;
  readonly failures: ReadonlyArray<string>;
}

async function playScenarios(): Promise<Result[]> {
  const results: Result[] = [];
  for (const [index, scenario] of corpus.scenarios.entries()) {
    const agentId = `${RUN}-${index}`;
    const failures: string[] = [];
    try {
      await register(agentId);
      const accepted: boolean[] = [];
      const events = scenarioEvents(scenario, {
        corpusAgentId: corpus.agentId,
        agentId,
        // Request ids are global to a bridge and a settled one never reopens.
        requestPrefix: `${agentId}-`,
        // Rebased onto now, or every claim in the corpus is long expired
        // against the bridge's own clock by the time it is asserted on.
        baseTimeMs: Date.now(),
      });
      for (const event of events) {
        const { status, payload } = await call(
          "POST",
          `/agents/${encodeURIComponent(agentId)}/runtime-events`,
          event,
        );
        if (scenario.httpRefused) {
          // The scenario is about a guard below this surface; what the route
          // owes it is a refusal.
          if (status < 400 || status >= 500) {
            failures.push(
              `posting ${String(event.type)} should be refused, and answered ${status}`,
            );
          }
          continue;
        }
        if (status >= 300) {
          failures.push(`posting ${String(event.type)} answered ${status}`);
          accepted.push(false);
          continue;
        }
        // A report that lost its race is dropped as a success, and says so in
        // the body rather than in the status.
        accepted.push(field(payload, "accepted") !== false);
      }
      if (!scenario.httpRefused) {
        const agent = await snapshotAgent(agentId);
        failures.push(...conformanceFailures(scenario, agent, accepted, OBSERVABLE));
      }
    } catch (cause) {
      failures.push(cause instanceof Error ? cause.message : String(cause));
    }
    results.push({ name: scenario.case, failures });
  }
  return results;
}

/**
 * A prompt sent to a session that is blocked is refused with `agent_blocked`,
 * and the same prompt with `force` is queued. An adapter that treats the
 * refusal as a transport failure retries forever; one that treats it as
 * delivery loses the message.
 */
async function blockedRefusal(): Promise<Result> {
  const agentId = `${RUN}-blocked`;
  const failures: string[] = [];
  try {
    await register(agentId);
    await call("POST", `/agents/${agentId}/runtime-events`, {
      id: `${agentId}-r`,
      agentId,
      type: "request.opened",
      requestId: `${agentId}-r1`,
      createdAt: new Date().toISOString(),
      payload: { tool: "Bash", detail: "rm -rf build" },
    });
    const refused = await call("POST", `/agents/${agentId}/control`, {
      action: "prompt",
      value: "carry on",
    });
    if (refused.status !== 409 || field(refused.payload, "error") !== "agent_blocked") {
      failures.push(
        `a prompt to a blocked session should answer 409 agent_blocked, and answered ${refused.status} ${JSON.stringify(refused.payload)}`,
      );
    }
    const forced = await call("POST", `/agents/${agentId}/control`, {
      action: "prompt",
      value: "queue anyway",
      force: true,
    });
    if (forced.status >= 300) {
      failures.push(`a forced prompt should be accepted, and answered ${forced.status}`);
    }
  } catch (cause) {
    failures.push(cause instanceof Error ? cause.message : String(cause));
  }
  return { name: "a blocked session refuses a prompt, and takes a forced one", failures };
}

/**
 * A command is delivered at most once: acknowledge it before acting on it, and
 * the next poll no longer offers it. An adapter that acts first and
 * acknowledges after will replay every instruction it was mid-way through when
 * it restarted.
 */
async function deliveredAtMostOnce(): Promise<Result> {
  const agentId = `${RUN}-queue`;
  const failures: string[] = [];
  try {
    await register(agentId);
    const queued = await call("POST", `/agents/${agentId}/control`, {
      action: "prompt",
      value: "look at the parser",
    });
    if (queued.status >= 300) throw new Error(`queueing a prompt answered ${queued.status}`);
    const first = await call("GET", `/agents/${agentId}/commands`);
    const commands = field(first.payload, "commands");
    const command = Array.isArray(commands) ? commands[0] : undefined;
    const commandId = command === undefined ? undefined : field(command, "id");
    if (commandId === undefined || !isJsonString(commandId)) {
      throw new Error(
        `polling should offer the queued command, and offered ${JSON.stringify(commands)}`,
      );
    }
    const ack = await call("POST", `/agents/${agentId}/commands/${commandId}/ack`);
    if (ack.status >= 300) failures.push(`acknowledging answered ${ack.status}`);
    const second = await call("GET", `/agents/${agentId}/commands`);
    const remaining = field(second.payload, "commands");
    if (Array.isArray(remaining) && remaining.length > 0) {
      failures.push("an acknowledged command was offered again");
    }
  } catch (cause) {
    failures.push(cause instanceof Error ? cause.message : String(cause));
  }
  return { name: "an acknowledged command is not delivered twice", failures };
}

/**
 * A request id is global to the bridge, and a settled one stays settled: an
 * adapter that numbers its approvals 1, 2, 3 per session and reconnects will
 * reopen ids the bridge has already answered, and every one of them will
 * block nothing. Nothing said so until a conformance run tripped over it.
 */
async function settledRequestIdsStaySettled(): Promise<Result> {
  const agentId = `${RUN}-reused`;
  const requestId = `${RUN}-reused-r`;
  const failures: string[] = [];
  const open = (id: string) =>
    call("POST", `/agents/${agentId}/runtime-events`, {
      id: `${agentId}-${id}-open`,
      agentId,
      type: "request.opened",
      requestId: id,
      createdAt: new Date().toISOString(),
      payload: { tool: "Bash", detail: "rm -rf build" },
    });
  try {
    await register(agentId);
    await open(requestId);
    await call("POST", `/agents/${agentId}/runtime-events`, {
      id: `${agentId}-resolve`,
      agentId,
      type: "request.resolved",
      requestId,
      createdAt: new Date().toISOString(),
      payload: { status: "approved" },
    });
    await open(requestId);
    const reused = await call("POST", `/agents/${agentId}/control`, {
      action: "prompt",
      value: "after reopening a settled id",
    });
    if (reused.status === 409) {
      failures.push(
        "reopening a settled request id blocked the session; the ledger is supposed to keep a terminal request terminal",
      );
    }
    const fresh = `${requestId}-fresh`;
    await open(fresh);
    const blocked = await call("POST", `/agents/${agentId}/control`, {
      action: "prompt",
      value: "after a fresh id",
    });
    if (blocked.status !== 409) {
      failures.push(`a fresh request id should block a prompt, and answered ${blocked.status}`);
    }
  } catch (cause) {
    failures.push(cause instanceof Error ? cause.message : String(cause));
  }
  return { name: "a settled request id does not reopen, and a fresh one blocks", failures };
}

const results = [
  ...(await playScenarios()),
  await blockedRefusal(),
  await deliveredAtMostOnce(),
  await settledRequestIdsStaySettled(),
];
for (const result of results) {
  if (result.failures.length === 0) {
    console.log(`  ok   ${result.name}`);
    continue;
  }
  console.log(`  FAIL ${result.name}`);
  for (const failure of result.failures) console.log(`         ${failure}`);
}
const failed = results.filter((result) => result.failures.length > 0).length;
console.log(
  `\n${results.length - failed}/${results.length} conformance checks passed against ${base}`,
);
// Said plainly rather than left for a reader to infer from a green run: the
// snapshot exposes three of the projection's fields, so the scenarios are
// checked on those and the in-process runner covers the rest.
console.log(`scenario checks cover ${OBSERVABLE.join(", ")}; the rest are checked by bun test`);
console.log(`sessions created: ${RUN}-*`);
process.exit(failed > 0 ? 1 : 0);
