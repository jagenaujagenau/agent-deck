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

## Product Experience Bar
Agent Deck must feel award-worthy in daily use, not merely look polished in screenshots. Phone and watch interactions prioritize immediate feedback, stable spatial behavior, excellent typography, deliberate optical alignment, fluid interruptible motion, clear hierarchy, and calm information density. Visual novelty never outranks operational truth, capability safety, accessibility, performance, or native platform behavior. Every primary flow is evaluated in loading, live, waiting, error, stale, empty, keyboard, and recovery states on real Pixel hardware.
