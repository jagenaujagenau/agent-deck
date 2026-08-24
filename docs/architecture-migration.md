# Runtime architecture migration

This migration is intentionally additive so active externally launched agents remain controllable throughout the cutover.

## Production now

- Canonical runtime-event vocabulary and validation
- Durable ordered `bridge_runtime_events`
- Pure sequence-aware `bridge_runtime_projections`
- Durable approval/user-input `bridge_requests`
- Terminal requests cannot be reopened by delayed heartbeats
- Snapshot sequence persisted in `bridge_meta`; Android rejects older snapshots
- Android connection supervisor state, capped backoff, authentication blocking, foreground probes, and network-change wakeups
- Current context usage separated from monotonic processed usage
- Global cross-transcript Claude de-duplication and Codex rollout delta/fork-copy suppression for tracked sessions, with five-minute scan caching
- IANA-timezone analytics buckets, disjoint token facets, and explicit priced-cost coverage
- Stable identities for hook-reported tool completion updates
- Scoped paired-device read/control credentials; runtime ingestion requires the master credential
- Idempotent command IDs and durable command receipts
- Wear command outbox persisted in SQLite with runtime-delivery acknowledgement and visible timeout/failure
- Managed-runtime registry and capability interface
- Concrete host-owned Claude SDK Implementation with streaming prompts, canonical events, direct controls, durable SQLite permission continuations, safe paired-device single-select answers, and fail-closed restart recovery

## Compatibility phase

Pi and runtime hooks now publish canonical lifecycle events. Snapshots use canonical projections per session only when heartbeat/projection parity is proven; a mismatched or pre-migration session automatically falls back to its compatibility heartbeat so an approval can never be hidden. The two current live Claude sessions have reached parity and are projection-backed.

## Remaining cutover work

1. Implement Codex app-server and ACP managed adapters when their executables/protocol hosts are available. Keep hooks as the external-session Adapter; unavailable capabilities remain gated rather than simulated.
2. Add a native create-session surface if managed session creation should be exposed beyond the master-token API.
