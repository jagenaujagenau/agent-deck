# The Bridge API

The bridge is the product. It pulls live activity out of every harness a
session might run in — Claude Code, Codex, OpenCode, Pi — and unifies it into
one canonical stream: messages, reasoning, terminal activity, file changes,
approvals, questions, usage. Anything can be built on top of that stream; the
Android, Wear OS, and iOS apps in this repository are reference clients, not
the point.

This document is the wire contract those clients — and yours — are written
against. Everything here is served under `/bridge/v1`.

## Conventions

**Auth.** Every route except `POST /pair` takes `Authorization: Bearer <token>`.
Tokens come in two shapes: the master runtime credential (`BRIDGE_TOKEN`, held
by adapters), and per-device tokens minted by pairing. A route needs one of two
scopes: `read` (everything that observes, including `POST /agents/:id/seen` —
looking at a conversation is reading) or `control` (`/control`, request
resolution). Enforcement is on only when `BRIDGE_REQUIRE_AUTH=true`; the bridge
logs a warning at startup whenever refusal is off.

**Pairing.** `POST /pair` with `{code, deviceName}` exchanges a short-lived
single-use pairing code (printed by the bridge at startup) for
`{id, token, name, createdAt}`. Codes expire, and ten failures lock pairing
out. `DELETE /device` revokes the calling device's token. Tokens and codes are
stored only as SHA-256 hashes; comparisons are constant-time.

**Errors.** Failures are JSON: `{"error": "<sentence>"}` with a fitting status.
One error string is load-bearing wire contract: `agent_blocked` (below).

## The live stream

`GET /events` — Server-Sent Events. Three frame types:

- `event: snapshot` — the first frame: the full `BridgeSnapshot`
  (`{sequence, bridge, summary, agents}`). The `id:` field carries the
  revision.
- `event: patch` — every later change: `{sequence, bridge, summary, agents,
  removed}` where `agents` holds only agents whose rendered state changed and
  `removed` the ids of agents that are gone. Everything absent is unchanged;
  apply by replacing matching agents, dropping removed ids, and appending new
  ones. Diffing is per-connection (each subscriber has its own fingerprint
  map), so frames from one connection mean nothing to another.
- `event: ping` — keepalive every 15 seconds, so proxies keep the connection.

Measured on this bridge: an event posted to a quiet deck reaches a subscriber
in ~2 ms at the median; a 20-subscriber fan-out lands on the slowest screen in
~14 ms. Reproduce with `bun run bench`.

## An agent, on the wire

A snapshot agent: `id`, `name`, `project`, `model`, `state`, `task`,
`objective?`, `progress?`, `tokens`, `processedTokens?`, `costUsd`,
`lastSeenAt`, `viewedAt?`, `runtime?`, `events` (a rolling window of the ~24
newest, newest first), `capabilities?`, `rateLimits`, `pendingApproval?`,
`pendingQuestion?`.

- `state` is one of `idle`, `running`, `waiting`, `paused`, `error`,
  `offline`. Offline is derived: a session that stopped heartbeating is
  offline after 45 s (10 min if it was idle — idle sessions legitimately go
  quiet).
- `runtime` is the adapter's own word for its harness — `claude`, `codex`,
  `opencode`, `pi`. Trust it over any name heuristic.
- `viewedAt` is the last moment a person looked at this session on any
  surface. Seen is shared, not per-device: mark it with
  `POST /agents/:id/seen` (no body → `{viewedAt}`), and treat an agent as seen
  when a local mark **or** `viewedAt` covers its latest activity. Machine
  reads must never mark seen.
- Snapshot events are trimmed for cards: `detail` is clipped and `command` and
  `diff` are dropped. The full versions live in history — merge history under
  live events by id, and prefer the history copy's `command`/`diff`/long
  `detail`.

## Events

An `AgentEvent`: `id`, `kind`, `summary`, `detail?`, `createdAt`, `tool?`,
`path?`, `command?`, `diff?`, `options?`, `subagentId?`, `subagentType?`,
`subagentName?`.

`kind` is one of:

| kind | meaning |
| --- | --- |
| `user` | the person speaking — a prompt, wherever it was typed |
| `output` | the agent speaking, or activity output |
| `thought` | reasoning, streamed as the turn progresses |
| `tool` | a tool call; `command` for shells, `path` + `diff` for file edits |
| `question` | the agent asking; `options` carries the choices |
| `warning`, `error` | what they say |

Subagent fields thread a child's work through its parent's stream:
`subagentId` marks whose work an event is (absent on the parent's own),
`subagentName` is the errand in the delegating call's own words ("Fix lint in
apps/server") — title a subagent by name, falling back to its type.

Publishing an event with an `id` the session already has **revises** that
event in place (a tool's diff arrives with its completion); order by
`createdAt`, not arrival.

## Reading a session

- `GET /snapshot` — the same shape as the SSE snapshot frame, for one-shot
  reads.
- `GET /agents/:id/history?limit=N` — the retained event log, oldest first.
  Conversation and activity are fetched and trimmed as separate budgets (the
  conversation keeps priority, activity keeps at least a third), so neither a
  chatty session nor a tool-heavy one starves the other's tab.
- `GET /agents/:id/changes` — every file change the session produced, with
  diffs.
- `GET /agents/:id/slash-commands` — what the session can be asked to run by
  name (`{commands: [{name, description?, source}]}`).
- `GET /analytics?range=&project=&timeZone=` — usage: totals, series, heatmap,
  per-project and per-runtime breakdowns, rate-limit windows.

## Acting on a session

`POST /agents/:id/control` with `{action, value?, commandId?, force?}`.
Actions: `pause`, `resume`, `stop`, `approve`, `reject`, `prompt`, `steer`,
`follow_up`. Answers: `202` with the queued command, `404` unknown agent,
`409` when the runtime does not support the action.

**The blocked refusal.** A `prompt`/`steer`/`follow_up` aimed at a session
that is waiting on an approval or question is refused:

```json
409 {"error": "agent_blocked", "detail": "The agent is waiting for approval to run Bash"}
```

Clients detect this by matching the `error` string — it is never reworded.
Show the refusal and offer an explicit "send anyway" that retries with
`force: true`. `approve`/`reject`/`stop`/`pause`/`resume` are never refused
this way; they are how a blocked session gets unblocked.

Delivery is observable: `GET /commands/:id/receipt` reports
`{commandId, status, error?, resultSequence?, updatedAt}`.

Questions and approvals are durable requests:
`GET /agents/:id/requests/:requestId` polls status;
`POST /agents/:id/requests/:requestId/resolve` answers one (device answers
record `answered`; only the runtime credential may record another outcome).

## Hosting sessions

The bridge can run sessions itself, not only observe them.
`GET /managed/runtimes` lists what it can host;
`POST /managed/claude/sessions` with `{project, cwd, model?, objective?,
prompt?, permissionMode?}` starts one (the `cwd` must be a path the bridge has
already seen a session run in). Managed approvals resolve through
`POST /managed/:agentId/requests/:requestId/resolve`.

## Publishing (the adapter side)

An adapter is anything that can speak three routes:

- `POST /agents/heartbeat` — identity and liveness: `{id, name, project,
  model, state, task, tokens, costUsd, ...}` plus optional `runtime`,
  `capabilities`, `rateLimits`, `pendingApproval`. Repeating totals is safe:
  usage is stored as deltas against a high-water cursor.
- `POST /agents/:id/events` — `AgentEvent` input; the bridge assigns `id` and
  `createdAt` when omitted.
- `POST /agents/:id/runtime-events` — the canonical vocabulary, for adapters
  that speak it (`runtimeProtocol: "canonical-v1"`): `session.registered`,
  `session.state.changed`, `turn.started`, `turn.completed`, `item.started`,
  `item.updated`, `item.completed`, `request.opened`, `request.resolved`,
  `runtime.error`. A `session.state.changed` may carry
  `origin: {source, seq}`; the bridge drops reports whose sequence is not
  newer than the last accepted from that source, answering
  `201 {"accepted": false, "reason": "stale"}` — so a delayed delivery can
  never resurrect a dead state.
- `POST /agents/:id/slash-commands` — publish the session's runnable catalog
  (project and user prompts, skills, plugins; capped at 400).
- `GET /agents/:id/commands` + `POST /agents/:id/commands/:commandId/ack` —
  the queue of remote instructions; acknowledge before delivering, so a
  message is delivered at most once.

The reference adapters live in `integrations/` (hook-driven for Claude Code
and Codex, in-process for OpenCode and Pi, terminal-driven for herdr) and are
held to a parity matrix: `apps/server/scripts/parity.ts`.

## Diagnostics

`GET /` (the server root, outside `/bridge/v1` and outside auth) — liveness,
name, and version: `{status, name, version}`; a version is not a secret, and
the service wrapper polling it has no credential to offer.
`GET /diagnostics/projection-parity` — per-agent
comparison of what heartbeats report against what runtime events project,
which is how a drifting adapter is caught.
