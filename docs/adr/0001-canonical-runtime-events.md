# ADR-0001: Canonical runtime events and incremental projection migration

- Status: Accepted
- Date: 2026-08-24

## Context

Agent Deck originally persisted mutable Agent heartbeat documents. Provider lifecycle vocabulary, current attention, usage, and event history could disagree after delayed hooks, reconnects, or process restarts.

A live migration must not break already-running Pi, Claude Code, Codex, Android, or Wear OS installations.

## Decision

The bridge accepts validated canonical Runtime Events and stores them in a durable ordered log. A pure Runtime Projection is maintained in parallel with legacy Agent documents during migration.

Approvals and user-input interactions are durable Requests keyed by request ID. Commands use caller-supplied idempotency IDs and durable receipts. Snapshots carry a durable monotonic sequence; clients reject older snapshots.

Heartbeat documents remain a compatibility Adapter until each runtime publishes a complete canonical lifecycle. Historical Processed Usage and live Context Usage are separate fields.

## Consequences

- Existing runtimes remain operational during migration.
- New behavior should be tested through the Runtime Event and Runtime Projection interfaces.
- The legacy Agent document can be removed only after Pi, Claude, Codex, phone, and watch consume the canonical path.
- The bridge temporarily stores both legacy projections and canonical events.
