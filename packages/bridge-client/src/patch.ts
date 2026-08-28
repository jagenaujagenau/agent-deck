import type { BridgeSnapshot, BridgeSnapshotPatch } from "./types";

/**
 * Applies a patch to the snapshot it was computed against, preserving agent
 * order where possible: matching agents are replaced in place, removed ids are
 * dropped, and agents seen for the first time append.
 *
 * Mirrored on every surface (BridgeModels.kt, BridgeModels.swift); the rule
 * itself is stated in docs/bridge-api.md.
 */
export function applyPatch(snapshot: BridgeSnapshot, patch: BridgeSnapshotPatch): BridgeSnapshot {
  const changed = new Map(patch.agents.map((agent) => [agent.id, agent]));
  const removed = new Set(patch.removed);
  const kept = snapshot.agents
    .filter((agent) => !removed.has(agent.id))
    .map((agent) => changed.get(agent.id) ?? agent);
  const known = new Set(snapshot.agents.map((agent) => agent.id));
  const added = patch.agents.filter((agent) => !known.has(agent.id));
  return {
    sequence: patch.sequence,
    bridge: patch.bridge,
    summary: patch.summary,
    agents: [...kept, ...added],
  };
}
