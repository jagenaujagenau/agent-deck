/**
 * Replays real request bodies against both bridges and compares status codes.
 *
 * The rewrite parses bodies at the boundary where the deployed bridge checked a
 * couple of fields by hand. That is only safe if it refuses exactly the same
 * traffic, so this drives both with the same inputs - including the awkward
 * shapes a runtime actually produces - and reports any divergence.
 */
import { Database } from "bun:sqlite";
import type { JsonObject } from "../src/effect/Domain";

const TOKEN = process.env.BRIDGE_TOKEN!;
const ORIG = "http://127.0.0.1:3997/bridge/v1";
const EFFECT = "http://127.0.0.1:3998/bridge/v1";

const post = async (base: string, path: string, payload: string) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: payload,
  });
  return res.status;
};

const db = new Database(process.env.DB!, { readonly: true });
const agents = db
  .query<{ data: string }, []>("SELECT data FROM bridge_agents LIMIT 40")
  .all()
  .map((r): JsonObject => JSON.parse(r.data));
const events = db
  .query<
    {
      kind: string;
      summary: string;
      detail: string | null;
      tool: string | null;
      command: string | null;
      path: string | null;
    },
    []
  >("SELECT kind, summary, detail, tool, command, path FROM bridge_session_events LIMIT 60")
  .all();

// `body` is deliberately open: the whole point of these cases is to replay the
// awkward, unparsed shapes a runtime actually sends. `raw` carries the one body
// that must go over the wire without being serialised as JSON first.
type Case = { label: string; path: string; body?: unknown; raw?: string };
const cases: Case[] = [];

// Real heartbeats, exactly as they were stored.
for (const [i, a] of agents.entries()) {
  const { events: _events, lastSeenAt: _seen, ...rest } = a;
  cases.push({ label: `heartbeat/stored#${i}`, path: "/agents/heartbeat", body: rest });
}
// Real events.
for (const [i, e] of events.entries()) {
  cases.push({
    label: `event/stored#${i}`,
    path: `/agents/${encodeURIComponent(String(agents[0]?.id ?? "x"))}/events`,
    body: {
      kind: e.kind,
      summary: e.summary,
      detail: e.detail,
      tool: e.tool,
      command: e.command,
      path: e.path,
    },
  });
}
// The shapes that decide whether parsing is too strict.
const base = { id: "wp", name: "n", project: "p", model: "m", state: "idle", task: "t" };
const edge: Case[] = [
  { label: "heartbeat/minimal", path: "/agents/heartbeat", body: base },
  {
    label: "heartbeat/nulls-on-optionals",
    path: "/agents/heartbeat",
    body: {
      ...base,
      objective: null,
      progress: null,
      tokens: null,
      costUsd: null,
      capabilities: null,
      rateLimits: null,
      pendingApproval: null,
    },
  },
  {
    label: "heartbeat/unknown-extra-key",
    path: "/agents/heartbeat",
    body: { ...base, futureField: { nested: true } },
  },
  {
    label: "heartbeat/float-tokens",
    path: "/agents/heartbeat",
    body: { ...base, tokens: 1.5, costUsd: 0.001 },
  },
  { label: "heartbeat/missing-id", path: "/agents/heartbeat", body: { ...base, id: undefined } },
  {
    label: "heartbeat/missing-state",
    path: "/agents/heartbeat",
    body: { ...base, state: undefined },
  },
  { label: "heartbeat/bad-state", path: "/agents/heartbeat", body: { ...base, state: "zzz" } },
  { label: "heartbeat/empty", path: "/agents/heartbeat", body: {} },
  { label: "heartbeat/not-json", path: "/agents/heartbeat", raw: "<<not json>>" },
  { label: "event/minimal", path: "/agents/wp/events", body: { kind: "output", summary: "s" } },
  {
    label: "event/null-detail",
    path: "/agents/wp/events",
    body: { kind: "output", summary: "s", detail: null },
  },
  { label: "event/missing-summary", path: "/agents/wp/events", body: { kind: "output" } },
  { label: "event/bad-kind", path: "/agents/wp/events", body: { kind: "nope", summary: "s" } },
  {
    label: "event/options-array",
    path: "/agents/wp/events",
    body: { kind: "question", summary: "q", options: ["a", "b"] },
  },
  { label: "control/bad-action", path: "/agents/wp/control", body: { action: "fly" } },
  { label: "control/missing-action", path: "/agents/wp/control", body: {} },
  { label: "control/steer", path: "/agents/wp/control", body: { action: "steer", value: "go" } },
  {
    label: "control/null-value",
    path: "/agents/wp/control",
    body: { action: "steer", value: null },
  },
  { label: "slash/not-array", path: "/agents/wp/slash-commands", body: { commands: "nope" } },
  { label: "slash/empty-array", path: "/agents/wp/slash-commands", body: { commands: [] } },
  {
    label: "slash/arbitrary-entries",
    path: "/agents/wp/slash-commands",
    body: { commands: [{ anything: 1 }, "str"] },
  },
  {
    label: "resolve/bad-status",
    path: "/agents/wp/requests/r1/resolve",
    body: { status: "pending" },
  },
  {
    label: "resolve/answered",
    path: "/agents/wp/requests/r1/resolve",
    body: { status: "answered", value: "x" },
  },
  { label: "pair/bad-code", path: "/pair", body: { code: "12", deviceName: "d" } },
  { label: "pair/blank-name", path: "/pair", body: { code: "123456", deviceName: "  " } },
  { label: "pair/missing-name", path: "/pair", body: { code: "123456" } },
  { label: "managed/missing-cwd", path: "/managed/claude/sessions", body: { project: "p" } },
  {
    label: "managed/bad-mode",
    path: "/managed/claude/sessions",
    body: { project: "p", cwd: "/tmp", permissionMode: "zzz" },
  },
  {
    label: "runtime-events/agent-mismatch",
    path: "/agents/wp/runtime-events",
    body: {
      agentId: "other",
      id: "1",
      type: "runtime.error",
      createdAt: "2026-01-01T00:00:00Z",
      payload: {},
    },
  },
];
cases.push(...edge);

let same = 0;
const diffs: string[] = [];
for (const c of cases) {
  const payload = c.raw ?? JSON.stringify(c.body);
  const [a, b] = await Promise.all([post(ORIG, c.path, payload), post(EFFECT, c.path, payload)]);
  if (a === b) same += 1;
  else diffs.push(`  ${c.label.padEnd(34)} original=${a}  effect=${b}`);
}
console.log(`write parity: ${same}/${cases.length} identical status`);
if (diffs.length) {
  console.log("DIVERGENCE:");
  for (const d of diffs) console.log(d);
}
