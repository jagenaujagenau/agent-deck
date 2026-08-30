# ADR-0002: State Authority as a time-boxed lease on state reports

- Status: Accepted
- Date: 2026-08-30

## Context

Two publishers can honestly disagree about one session. The Claude hooks fire
on tool calls and questions; herdr reads the terminal and sees the runtime's
own UI — a session frozen on "Resume from summary" is blocked to herdr and
silent to every hook. Per-source ordering (`origin.seq`) stops a publisher
racing itself, but nothing stopped a delayed hook report from overwriting the
waiting state herdr had just claimed; the two corrected each other in a loop.

Luvus (Apache-2.0) solves the same problem with `agent.report {source,
sequence, ttl_s}`: one leased owner per pane, competing sources rejected,
expiry decaying to heuristics with an observable release.

## Decision

A `session.state.changed` report may carry `claim: {ttlMs}`. The Runtime
Projection folds it into a State Authority lease `{source, expiresAt}`:

- While the lease is live, a state report from any other source advances the
  fold's cursor but does not move state or task — including a competing
  claim, which is suppressed rather than a takeover.
- The holder's next report **without** a claim is the release, and so is the
  holder resolving the request its claim existed for; a stranger's report
  after expiry sweeps a dead lease out. TTLs are capped at 24 hours.
- Only state reports are guarded. Lifecycle events (turn, item, request)
  are positive evidence that something real happened and always apply.
- A claim without an `origin` is no claim: authority must be attributable.

The lease lives in the pure fold (`runtime-projector.ts`), so it is
replayable and tested through the Runtime Projection interface (ADR-0001).
The snapshot exposes a live `stateAuthority` per agent as provenance.

herdr claims with the answer window (10 minutes) when it blocks a session;
its clear pass and answered-prompt report release by construction. The hooks
claim symmetrically while a deck-answerable Request is open — an approval or
question, for exactly that request's window — and deliberately not for a
waiting state only the terminal can see, where the observer reading the
screen is the better describer.

## Consequences

- The hooks cannot overwrite a terminal-prompt claim; herdr's self-healing
  re-block loop remains as the recovery path after expiry.
- A crashed claimant decays within its TTL instead of lying forever.
- Suppression is visible: the snapshot says whose claim is being honoured.
- Cross-source conflicts are resolved by waiting, not priority; a ranked
  authority vocabulary (integration report over heuristics) is deliberately
  deferred until a third publisher kind needs it.
