#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  AgentDeckClient,
  type AgentState,
  type ControlAction,
} from "../../packages/agent-adapter/src/index";
import { countQueuedMessages, queuedMessageNotice } from "./remote-messages";
import {
  readConversationBacklog,
  readNewTranscript,
  type TranscriptMessage,
} from "./transcript-reasoning";

type DaemonState = {
  state: AgentState;
  task: string;
  objective?: string;
  name: string;
  model?: string;
  tokens?: number;
  processedTokens?: number;
  ownerPid?: number;
  capabilities?: ControlAction[];
  transcriptPath?: string;
  transcriptOffset?: number;
  rateLimits?: Array<{
    id: string;
    label: string;
    usedPercent: number;
    resetsAt?: string;
    account?: string;
  }>;
  pendingApproval?: {
    id: string;
    tool: string;
    detail: string;
    createdAt: string;
    expiresAt: string;
  };
};

function requiredArgument(index: number): string {
  const value = process.argv[index];
  if (!value) throw new Error("agentId, statePath, and project are required");
  return value;
}
const agentId = requiredArgument(2);
const statePath = requiredArgument(3);
const project = requiredArgument(4);
const pidPath = `${statePath}.pid`;
const client = new AgentDeckClient();
const HEARTBEAT_INTERVAL_MS = 10_000;
/** How often a running session's transcript is tailed for new reasoning. */
const REASONING_INTERVAL_MS = 2_000;
let stopped = false;
let lastStateFingerprint = "";

function loadState(): DaemonState | undefined {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as DaemonState;
  } catch {
    return undefined;
  }
}

function ownerIsAlive(pid?: number) {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code has no thinking hook and its hooks only fire at tool boundaries, so reasoning would
 * arrive a tool call at a time. Tailing here — the one process that runs between hooks — streams it
 * as the turn progresses, which is what the phone's card shows.
 */
function publishMessage(message: TranscriptMessage) {
  // The transcript is the terminal's own record, so publishing it verbatim is what keeps the app's
  // chat in sync. Ids are derived from transcript uuids, so re-publishing is a no-op at the bridge.
  return message.role === "user"
    ? client.event(agentId, {
        kind: "user",
        summary: "Message",
        detail: message.text,
        id: message.id,
      })
    : client.event(agentId, {
        kind: "output",
        summary: "Response",
        detail: message.text,
        id: message.id,
      });
}

/** One pass over the whole transcript, so the app shows turns that predate the bridge ever seeing this session. */
async function syncConversationBacklog() {
  const state = loadState();
  if (!state?.transcriptPath) return;
  for (const message of readConversationBacklog(state.transcriptPath, agentId)) {
    await publishMessage(message).catch(() => {});
  }
}

async function streamReasoning() {
  const state = loadState();
  if (!state?.transcriptPath) return;
  const cursor = { offset: state.transcriptOffset };
  const { reasoning, messages } = readNewTranscript(state.transcriptPath, cursor, agentId);
  if (cursor.offset !== state.transcriptOffset) {
    // Re-read the state file first: a hook may have written it while this pass was reading.
    const current = loadState() ?? state;
    current.transcriptOffset = cursor.offset;
    writeFileSync(statePath, JSON.stringify(current));
  }
  for (const message of messages) await publishMessage(message).catch(() => {});
  for (const block of reasoning) {
    await client
      .event(agentId, { kind: "thought", summary: "Reasoning", detail: block.text, id: block.id })
      .catch(() => {});
  }
}

async function heartbeat() {
  const state = loadState();
  if (!state) return;
  if (state.pendingApproval && Date.parse(state.pendingApproval.expiresAt) <= Date.now()) {
    state.pendingApproval = undefined;
    if (state.state === "waiting") {
      state.state = "idle";
      state.task = "Approval expired";
    }
    writeFileSync(statePath, JSON.stringify(state));
  }
  if (!ownerIsAlive(state.ownerPid) && state.state !== "offline") {
    state.state = "offline";
    state.task = "Runtime process ended";
    writeFileSync(statePath, JSON.stringify(state));
  }
  // Messages only reach the model when a turn ends, so an idle session can be holding one. Surface
  // that instead of letting the phone imply it was delivered. Counted, never acknowledged — the
  // Stop hook owns draining — and never written to the state file, so it clears on delivery.
  const queued =
    state.state === "offline" ? 0 : await countQueuedMessages(client, agentId).catch(() => 0);
  const notice = queuedMessageNotice(queued);
  // A canonical-v1 runtime's activity line is projected from its event stream, not from the
  // heartbeat payload, so the notice has to ride both or the phone never shows it.
  const displayTask = notice && state.state === "idle" ? notice : state.task;
  const stateFingerprint = createHash("sha256")
    .update(`${state.state}\u0000${displayTask}`)
    .digest("hex")
    .slice(0, 20);
  if (stateFingerprint !== lastStateFingerprint) {
    await client
      .runtimeEvent({
        id: `daemon-state:${agentId}:${stateFingerprint}`,
        agentId,
        type: "session.state.changed",
        createdAt: new Date().toISOString(),
        payload: { state: state.state, task: displayTask },
      })
      .then(() => {
        lastStateFingerprint = stateFingerprint;
      })
      .catch(() => {});
  }
  await client
    .heartbeat({
      id: agentId,
      name: state.name,
      project,
      model: state.model ?? (agentId.startsWith("claude-") ? "Claude Code" : "Codex"),
      runtime: agentId.startsWith("claude-") ? "claude" : "codex",
      runtimeProtocol: "canonical-v1",
      state: state.state,
      task: displayTask,
      objective: state.objective,
      tokens: state.tokens,
      processedTokens: state.processedTokens,
      capabilities: state.capabilities ?? ["approve", "reject", "steer", "prompt", "follow_up"],
      rateLimits: state.rateLimits,
      pendingApproval: state.pendingApproval,
    })
    .catch(() => {});
  if (state.state === "offline") stopped = true;
}

writeFileSync(pidPath, String(process.pid));
const shutdown = () => {
  stopped = true;
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  // Catch the app up on everything the terminal already showed before this daemon started.
  await syncConversationBacklog().catch(() => {});
  let nextHeartbeat = 0;
  while (!stopped) {
    // Reasoning is tailed on a tighter cadence than the heartbeat: it is what a watching phone
    // sees change, while the heartbeat only has to prove the session is alive.
    await streamReasoning();
    if (Date.now() >= nextHeartbeat) {
      await heartbeat();
      nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
    }
    if (!stopped)
      await Bun.sleep(
        loadState()?.state === "running" ? REASONING_INTERVAL_MS : HEARTBEAT_INTERVAL_MS,
      );
  }
  await heartbeat();
} finally {
  try {
    unlinkSync(pidPath);
  } catch {
    /* Already replaced or cleaned up. */
  }
}
