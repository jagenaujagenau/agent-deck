# Domain Context

## Agent
A real Pi, Claude Code, Codex, or future managed runtime session visible in Agent Deck. An Agent may be externally observed or managed by the host.

## Project
The stable repository or workspace root that owns an Agent. A tool's transient working directory—such as `src`, `ui`, `input`, or `terminal`—is Locality inside a Project, never a new Project identity.

## Runtime Event
A validated, immutable fact emitted by a runtime Adapter. Runtime Events use canonical lifecycle names and carry a durable sequence after ingestion.

## Runtime Projection
The current Agent state derived by folding ordered Runtime Events. It distinguishes live context pressure from monotonic processed usage.

## Request
A durable interaction opened by a runtime and resolved exactly once. Approval and user-input Requests are distinct kinds; generic waiting state is not a Request.

## Permission Authority
The component entitled to decide whether a tool may run. In ask-capable modes, Agent Deck may open a durable approval Request. In runtime-owned `auto`, `bypassPermissions`, and `dontAsk` modes, the runtime remains the sole Permission Authority and Agent Deck observes without opening a redundant Request.

## State Authority
A time-boxed exclusive claim over a session's state reports, held by one publisher (an origin source) and folded into the Runtime Projection. A state report carrying `claim: {ttlMs}` takes or refreshes the lease; the holder's next report without one releases it, and the clock releases a holder that died. While live, state reports from other sources advance the event log but not the projected state. Lifecycle events (turns, items, Requests) are never suppressed — a claim guards opinions, not facts.

## Command
An idempotent request from phone or watch to change an Agent. A Command has a durable receipt and delivery status.

## Environment
One host bridge and the projects, Agents, credentials, usage sources, and access endpoints it owns.

## Access Endpoint
A concrete authenticated route to an Environment. Tailscale HTTPS is an access mechanism, not a separate Environment kind.

## Snapshot Sequence
A durable monotonic generation attached to bridge snapshots. Clients never apply a lower sequence over a higher one.

## Context Usage
Tokens currently occupying or produced around the active model context. Shown on live Agent cards.

## Processed Usage
Monotonic historical token usage. Used by Usage analytics and never inferred from current context pressure.

## Subagent Name
What a subagent run was asked to do, in the Task call's own wording ("Fix lint in apps/server"). Carried by the spawn event the daemon derives from the parent transcript's tool result — the one place the child's id and its errand meet. Surfaces title a run by name, falling back to the runtime's type ("general-purpose") for sessions observed by an older adapter.

## Seen
This person has viewed this Agent's latest activity. Only a human act (opening the session) marks seen; machine reads never do. Seen is shared through the bridge, not per-device: viewing a session marks it instantly in the surface's local store and publishes `viewedAt` on the Agent (POST /agents/:id/seen), so reading a conversation on the phone clears its badge on the watch — the way reading a Slack channel anywhere clears it everywhere. An Agent counts as seen when either the local store says so or its `viewedAt` is at or past its latest activity; newer activity re-badges it.

## Done
A derived, per-surface state: an Agent that went idle while unseen. "Finished while you weren't looking" outranks "running" in every surface's attention ordering, and decays to plain idle the moment the session is viewed.

## Attention Priority
One shared ranking every surface sorts by: error, then blocked (waiting), then done, then running, then idle-seen, then offline. The stuck one is always first, on every screen, by construction — including the glanceable ones (widget, tile), which rank with seen held neutral because a summary shared across surfaces cannot carry one surface's eyes. Parity of the three implementations (Kotlin, Swift, TypeScript) is enforced by `packages/bridge-client/fixtures/attention-parity.json`, which all three run as tests; extend the corpus, never one implementation.

## Blocked Refusal
A prompt, steer, or follow-up aimed at an Agent that is waiting on an approval or question is refused by the bridge with `agent_blocked` rather than silently queued — answering the block is the real next action. A device may deliberately queue anyway by forcing the command.

## Service Controller
The desktop app is a controller for the host bridge service — install, start, stop, and inspect the launchd job — and not a deck surface. It renders no Agents, holds no Snapshot Sequence, and speaks to its own Rust backend rather than the bridge wire, which is why it shares no types with the surfaces. A desktop deck view, if one comes, is a new surface built on `bridge-client`, not an extension of the controller.

## Product Experience Bar
Agent Deck must feel award-worthy in daily use, not merely look polished in screenshots. Phone and watch interactions prioritize immediate feedback, stable spatial behavior, excellent typography, deliberate optical alignment, fluid interruptible motion, clear hierarchy, and calm information density. Visual novelty never outranks operational truth, capability safety, accessibility, performance, or native platform behavior. Every primary flow is evaluated in loading, live, waiting, error, stale, empty, keyboard, and recovery states on real Pixel hardware.
