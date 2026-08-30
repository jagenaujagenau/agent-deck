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

Pi and runtime hooks now publish canonical lifecycle events. For a session declaring `runtimeProtocol: "canonical-v1"`, the snapshot believes the projection outright — the parity gate that discarded a mismatched projection was removed (it made corrections impossible and threw away the better usage numbers; see the comment at the snapshot site in `State.ts`). `projectionParity` is retained on the snapshot as a migration signal only. The heartbeat still supplies identity and liveness for runtimes that have not registered themselves. Cross-publisher disagreements over state are handled by State Authority leases (ADR-0002), not by falling back to the heartbeat.

## Remaining cutover work

1. Implement Codex app-server and ACP managed adapters when their executables/protocol hosts are available. Keep hooks as the external-session Adapter; unavailable capabilities remain gated rather than simulated.
2. Add a native create-session surface if managed session creation should be exposed beyond the master-token API.
3. Deleting the `runtimeProtocol: "canonical-v1"` flag needs more than per-field projection precedence. The flag plays two roles: snapshot precedence (replaceable by projection completeness, since legacy projections are folded from synthesized events anyway) and — the load-bearing one — suppressing the compat-event synthesis in `heartbeat`/`addEvent`. Synthesizing for a canonical runtime would publish origin-less state facts alongside the adapter's own ordered reports and make the projection flap between the two. The flag can go only when synthesis has a different off-switch — for example, skipping synthesis for any session whose recent events carry an `origin`.
