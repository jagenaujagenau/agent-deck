# agent-control-dashboard

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, Hono, TRPC, and more.

## Features

- **Android + Wear OS control surfaces** — native Jetpack Compose apps for monitoring, approvals, prompts, pause/resume, and stop controls
- **Agent bridge** — a small HTTP control plane with heartbeats, activity events, command queues, and optional bearer-token authentication
- **Tailscale-ready** — connect with a tailnet IP or MagicDNS URL; no public ingress is required
- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **shadcn/ui** - Reusable UI components
- **Hono** - Lightweight, performant server framework
- **tRPC** - End-to-end type-safe APIs
- **Bun** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **SQLite/Turso** - Database engine
- **Authentication** - Better-Auth
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
bun install
```

## Database Setup

This project uses SQLite with Drizzle ORM.

1. Start the local SQLite database (optional):

```bash
bun run db:local
```

2. Update your `.env` file in the `apps/server` directory with the appropriate connection details if needed.

3. Apply the schema to your database:

```bash
bun run db:push
```

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
The API and bridge run at [http://localhost:3000](http://localhost:3000).

## Android and Wear OS

The native project is in `apps/android` and contains `mobile`, `wear`, and shared networking modules. It targets Android 11+ and Wear OS 3+. The phone agent view separates Markdown-rendered user/agent conversation from a selectable monospace terminal activity stream. A capability-aware composer sends real `prompt`, `steer`, or `follow_up` commands; monitoring-only runtimes never show a simulated reply control.

```bash
# Point local device builds at a LAN, Tailscale IP, or MagicDNS hostname
printf '\nbridge.url=https://your-machine.your-tailnet.ts.net\n' >> apps/android/local.properties

cd apps/android
./gradlew :mobile:assembleDebug :wear:assembleDebug

adb -s <phone-serial> install -r mobile/build/outputs/apk/debug/mobile-debug.apk
adb -s <watch-serial> install -r wear/build/outputs/apk/debug/wear-debug.apk
```

The bridge prints a one-time six-digit pairing code at startup. On the phone, open connection settings, enter the bridge URL and code, then tap **Pair & connect**. The issued per-device token is encrypted with Android Keystore and can be revoked independently. The phone provisions that credential to the paired watch through the encrypted Wear Data Layer; the watch re-encrypts it under its own Android Keystore.

The watch does not need direct LAN, Tailscale, or ADB access. The phone's foreground monitor relays a compact, archive-filtered live projection through Wear Data Items and forwards watch refresh/control messages to the authenticated bridge. Full bridge snapshots can exceed the Data Layer item limit and are never relayed. A background Wear listener persists updates; the watch rejects lower sequences and gives a fresh phone projection priority over direct-network fallback.

HTTP is enabled for private LAN/tailnet development; prefer HTTPS through [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) for regular use:

```bash
tailscale serve --bg http://127.0.0.1:3000
```

For unattended macOS operation, install the bridge LaunchAgent. It starts at login, survives crashes, and writes stable logs under `~/Library/Logs/AgentDeck`:

```bash
bun scripts/bridge-service.ts install
bun scripts/bridge-service.ts status
bun scripts/bridge-service.ts restart
# bun scripts/bridge-service.ts uninstall
```

Set `BRIDGE_REQUIRE_AUTH=true` to require a paired device token or the `BRIDGE_TOKEN` master token on every protected bridge route. Device credentials are scoped to read/control operations; runtime ingestion and command polling require the master runtime credential. Pairing codes expire after ten minutes, are single-use, and lock after ten invalid attempts. Pi also reads a runtime credential from `~/.config/agent-deck/runtime-token` when `AGENT_DECK_TOKEN` is unset; keep that file mode `0600`. The bridge starts empty by default. Set `BRIDGE_DEMO_AGENTS=true` only when you explicitly want fixtures.

Agents, canonical runtime events, derived runtime projections, durable approval/user-input requests, idempotent commands and delivery receipts, and scoped paired devices are persisted in SQLite. Snapshots carry a durable monotonic `sequence`; phone and watch clients reject delayed snapshots older than the last sequence they applied.

On Android, a low-priority foreground monitor keeps the SSE connection alive while the UI is closed. It reconnects after network changes and emits high-priority actionable approval notifications, which Android can mirror to the paired Wear OS device. Approval actions require an explicit ten-minute `pendingApproval` lease published while a native runtime hook is actually blocked; a generic waiting/attention state or historical approval event can never create Approve/Reject controls. Bun's bridge idle timeout is explicitly longer than the 15-second SSE keepalive, and Android uses a no-read-timeout client only for long-lived streams.

A network-constrained WorkManager recovery job runs after boot/package replacement and periodically thereafter. It waits through the VPN startup race, fetches an authenticated durable snapshot, restores approval notifications, and refreshes the watch relay without opening the app. For unattended recovery, configure Tailscale as Android's always-on VPN; lockdown mode is optional.

The phone board groups sessions by project and prioritizes approvals/questions before working and completed turns. Its Command Center metrics are deliberately current-state counts (**Working**, **Needs you**, **Done**); historical tokens and spend live in **Usage** rather than being mixed into live status. Completed turns remain in **Live** for ten minutes, then decay into **History**; swipe a card to archive it immediately, and restore it from its detail sheet. Agent notifications deep-link to the exact session. The session view's **Changes** tab groups a turn's edits by file, with real `@@` line numbers: adapters snapshot each target before a tool rewrites it and publish a true unified diff, so a whole-file write reads as a change against what was there rather than a wall of additions. Structured questions, shell commands, file operations, and mini diffs render as native expandable cards. A question that offers preset choices is answerable from the phone and the watch: the runtime opens a durable `user-input` request and blocks on it, the device resolves it, and the answer is carried back into the session — for hook runtimes as the `PreToolUse` decision reason, for Pi as the tool block reason. Because a tool's own prompt cannot appear while the hook blocks, the remote window is deliberately short (`AGENT_DECK_QUESTION_TIMEOUT_MS`, default 30s; `0` never waits): an unanswered question falls through to the host terminal exactly as before. Free-text questions carry no options and stay host-only. Live cards show current context pressure. Historical analytics scan tracked-session transcripts: Claude records are globally deduplicated across resumed/forked histories, while Codex rollouts use `last_token_usage` deltas with duplicate and fork-copy suppression. Buckets use the device's IANA timezone, and priced-cost coverage prevents unpriced provider usage from appearing as known spend. The **Usage** destination includes token/cost history, project filters, activity heatmaps, runtime breakdowns, and real provider rate-limit windows when an adapter reports them.

## Connect real Pi sessions

`integrations/pi/` contains a Pi extension that publishes session state, model, token/cost usage, prompts, tool activity, and final output. It also executes remote prompts, pause/resume, stop, approve, and reject commands.

Install it globally so every Pi session is visible. The installer links both the extension and its shared runtime SDK into Pi's global resolution layout:

```bash
bun integrations/pi/install.ts
```

Then start Pi or run `/reload` in an existing session. The default bridge is `http://127.0.0.1:3000`. Override it when Pi and the bridge run on different machines:

```bash
export AGENT_DECK_URL=https://your-machine.your-tailnet.ts.net
export AGENT_DECK_TOKEN="$BRIDGE_TOKEN"
pi
```

Run `/deck-status` inside Pi to verify connectivity. Because this extension can accept remote instructions, use `BRIDGE_TOKEN` and HTTPS before exposing the bridge beyond a trusted local network or tailnet.

## Claude Code and Codex

`packages/agent-adapter` contains the reusable authenticated runtime SDK. `integrations/runtime-hooks` adapts native lifecycle hooks from Claude Code and Codex:

```bash
# Additive install; existing JSON is preserved and backed up once
bun integrations/runtime-hooks/install.ts all
```

The adapters publish session lifecycle, prompts, tool activity, failures, completion, usage, and attention requests. Each live session gets a supervised heartbeat daemon that survives individual hook exits, prevents long model turns from appearing offline, and marks the session offline when its runtime process ends. In Claude `default`/ask-capable modes, destructive `PreToolUse` calls block until Agent Deck approves or rejects them. In `auto`, `bypassPermissions`, and `dontAsk`, the hook defers entirely to Claude's own permission policy and never creates a redundant Agent Deck approval. If initial bridge contact is unavailable, the adapter falls back to the runtime's local permission prompt. Hook-only runtimes advertise `approve`, `reject`, `steer`, `prompt`, and `follow_up`, so only the unsupported pause and stop controls are disabled rather than simulated. Messaging works because a blocked `Stop` hook keeps a finishing turn alive and hands its `reason` back to the model as the next instruction: messages sent from the phone are queued on the bridge, drained at the end of the next turn, and delivered exactly once — a failed acknowledgement holds a message back rather than risking it running twice. A hook cannot type into a session already idle at its prompt, so a message sent to an idle session waits for its next turn; the heartbeat daemon reports that wait as the session's activity line (`1 message queued · delivers at the next turn`) instead of letting the phone imply the message was delivered. Claude Code is exercised end-to-end in this repository; Codex hooks are installed but require a local Codex executable for runtime verification.

### Host-managed Claude SDK sessions

The bridge can own a Claude process through `@anthropic-ai/claude-agent-sdk`. Creation is master-runtime-token only; paired device credentials cannot start arbitrary host processes.

```bash
curl -X POST "$BRIDGE_URL/bridge/v1/managed/claude/sessions" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project":"my-project","cwd":"/absolute/path/to/project","permissionMode":"auto","objective":"Fix the failing tests","prompt":"Diagnose and fix the test failure."}'
```

SDK tool permissions become durable `bridge_requests`. The SDK callback polls that durable record, while phone/watch approval uses the normal stale-safe control route. Managed single-select `AskUserQuestion` prompts expose native answer choices to paired control devices; multi-question, free-text, and multi-select formats remain host-terminal-only until dedicated native contracts exist. Approval command receipts become `delivered` only after the managed host handles them. If the bridge process restarts while Claude is blocked, the Agent becomes offline, the request resolves as `unavailable`, and a delayed approval receives `409` rather than executing stale work.

### Remote approval gate

The extension blocks high-risk shell commands and sensitive credential writes until the phone or watch responds. Approval requests expire after ten minutes. Phone notifications include direct **Approve** and **Reject** actions.

```text
/deck-gate destructive  # default: high-risk commands and credential files
/deck-gate all          # gate every bash, edit, and write tool call
/deck-gate off          # disable Agent Deck's Pi approval gate
/deck-test-approval     # harmless end-to-end test
```

Rejected and expired calls return a blocked tool result to Pi; approved calls continue with their original validated arguments.

## Bridge protocol

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/bridge/v1/pair` | Exchange a one-time code for a per-device token |
| `DELETE` | `/bridge/v1/device` | Revoke the calling device token |
| `GET` | `/bridge/v1/snapshot` | Dashboard state and recent activity |
| `GET` | `/bridge/v1/events` | Live SSE snapshots for Android and Wear OS |
| `GET` | `/bridge/v1/analytics` | Durable usage, activity, project/runtime breakdowns, heatmap data, and reported rate-limit windows |
| `GET` | `/bridge/v1/commands/:commandId/receipt` | Read queued/runtime-delivered command status |
| `GET` | `/bridge/v1/managed/runtimes` | List installed host-managed runtime capabilities; master token only |
| `POST` | `/bridge/v1/managed/claude/sessions` | Start a host-owned Claude SDK session; master token only |
| `POST` | `/bridge/v1/managed/:agentId/requests/:requestId/resolve` | Resolve managed structured input; paired control tokens may answer safe single-select questions, other statuses require the master token |
| `POST` | `/bridge/v1/agents/heartbeat` | Compatibility projection from an observed agent |
| `POST` | `/bridge/v1/agents/:id/runtime-events` | Publish a validated canonical runtime event |
| `POST` | `/bridge/v1/agents/:id/events` | Publish thought, question, structured tool/edit/diff, output, warning, or error activity |
| `POST` | `/bridge/v1/agents/:id/control` | Queue controls, including `steer` and `follow_up` messages |
| `GET` | `/bridge/v1/agents/:id/commands` | Agent-side command polling |
| `POST` | `/bridge/v1/agents/:id/commands/:commandId/ack` | Acknowledge execution |

A minimal heartbeat:

```bash
curl -X POST "$BRIDGE_URL/bridge/v1/agents/heartbeat" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -d '{"id":"pi-1","name":"Pi","project":"my-project","model":"claude","state":"running","task":"Implementing auth","progress":0.4,"tokens":1200,"costUsd":0.12}'
```

## Project Structure

```
agent-control-dashboard/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   ├── server/      # Backend API and agent bridge (Hono, tRPC)
│   └── android/     # Native Android, Wear OS, and shared modules
├── packages/
│   ├── agent-adapter/ # Reusable runtime bridge SDK
│   ├── api/           # API layer / business logic
│   ├── auth/          # Authentication configuration & logic
│   └── db/            # Database schema & queries
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:server`: Start only the server
- `bun run check-types`: Check TypeScript types across all apps
- `bun run db:push`: Push schema changes to database
- `bun run db:studio`: Open database studio UI
- `bun run db:local`: Start the local SQLite database
