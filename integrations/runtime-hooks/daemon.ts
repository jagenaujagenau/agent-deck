#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  AgentDeckClient,
  type AgentState,
  type ControlAction,
} from "../../packages/agent-adapter/src/index";
import { handleHookEvent } from "./hook-handler";
import { serveHookSocket, type SocketHookResponse } from "./hook-socket";
import { countQueuedMessages, queuedMessageNotice } from "./remote-messages";
import { ownerAlive } from "./process-identity";
import { approvalClaim } from "./state-claim";
import { nextReportSeq, REPORT_SOURCE } from "./report-seq";
import {
  readConversationBacklog,
  readNewTranscript,
  type SubagentSpawn,
  type TranscriptMessage,
  type TranscriptRuntime,
} from "./transcript-reasoning";

type DaemonState = {
  state: AgentState;
  task: string;
  objective?: string;
  name: string;
  cwd?: string;
  model?: string;
  tokens?: number;
  processedTokens?: number;
  ownerPid?: number;
  /** When the owner started — what makes the pid mean one process, not a slot. */
  ownerStart?: string;
  capabilities?: ControlAction[];
  transcriptPath?: string;
  transcriptOffset?: number;
  /** The report counter shared with the hook; every runtime event advances it. */
  reportSeq?: number;
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
const socketPath = `${statePath}.sock`;
// The agentId prefix is the keying convention for which runtime owns this session,
// and therefore which line grammar its transcript is read with.
const runtime = agentId.startsWith("claude-")
  ? "claude"
  : agentId.startsWith("gemini-")
    ? "gemini"
    : "codex";
/**
 * Gemini's conversation file is one JSON document rewritten in place, not an
 * append-only JSONL; neither transcript grammar below can tail it, so its chat
 * and reasoning arrive from the hooks instead of from here.
 */
const transcriptRuntime: TranscriptRuntime | undefined = runtime === "gemini" ? undefined : runtime;
const client = new AgentDeckClient();
const publisher = client.publisher(REPORT_SOURCE);
const HEARTBEAT_INTERVAL_MS = 10_000;
/** How often a running session's transcript is tailed for new reasoning. */
const REASONING_INTERVAL_MS = 2_000;
let stopped = false;
let lastStateFingerprint = "";

function loadState(): DaemonState | undefined {
  try {
    // SAFETY: the state file is this adapter's own — only the hook process and
    // this daemon write it, and both serialise exactly this shape. A corrupt
    // file fails the parse and lands in the catch, never in a caller.
    return JSON.parse(readFileSync(statePath, "utf8")) as DaemonState;
  } catch {
    return undefined;
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
        // A background agent finishing has a better headline than "Response",
        // and the runtime already wrote it.
        summary: message.summary ?? "Response",
        detail: message.text,
        id: message.id,
      });
}

/**
 * Names a subagent's run on the deck. The event is the delegation itself —
 * "Fix lint in apps/server" — and it carries the child's id, so the lens over
 * that subagent opens under the errand instead of under "general-purpose".
 */
function publishSpawn(spawn: SubagentSpawn) {
  return client.event(agentId, {
    kind: "tool",
    tool: "Task",
    summary: spawn.name,
    id: spawn.id,
    subagentId: spawn.subagentId,
    subagentName: spawn.name,
  });
}

/** One pass over the whole transcript, so the app shows turns that predate the bridge ever seeing this session. */
async function syncConversationBacklog() {
  const state = loadState();
  if (!state?.transcriptPath || transcriptRuntime === undefined) return;
  const backlog = readConversationBacklog(state.transcriptPath, agentId, transcriptRuntime);
  for (const message of backlog.messages) {
    await publishMessage(message).catch(() => {});
  }
  for (const spawn of backlog.spawns) await publishSpawn(spawn).catch(() => {});
}

async function streamReasoning() {
  const state = loadState();
  if (!state?.transcriptPath || transcriptRuntime === undefined) return;
  const cursor = { offset: state.transcriptOffset };
  const { reasoning, messages, spawns } = readNewTranscript(
    state.transcriptPath,
    cursor,
    agentId,
    transcriptRuntime,
  );
  if (cursor.offset !== state.transcriptOffset) {
    // Re-read the state file first: a hook may have written it while this pass was reading.
    const current = loadState() ?? state;
    current.transcriptOffset = cursor.offset;
    writeFileSync(statePath, JSON.stringify(current));
  }
  for (const message of messages) await publishMessage(message).catch(() => {});
  for (const spawn of spawns) await publishSpawn(spawn).catch(() => {});
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
  if (!ownerAlive(state.ownerPid, state.ownerStart) && state.state !== "offline") {
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
    // Two writers still share this session's state file: this heartbeat loop
    // and the event handler — usually in this same process via the socket,
    // but a hook that fell back runs it in its own. A heartbeat that loaded
    // the file, then yielded while an event advanced it, would otherwise
    // publish that older state over the newer one. The shared counter is what
    // lets the bridge drop this report when the handler already spoke past
    // it. Persisted before the wire, same as the handler.
    const seq = nextReportSeq(statePath, state);
    writeFileSync(statePath, JSON.stringify(state));
    await publisher(
      agentId,
      "session.state.changed",
      // Waiting on a live approval carries its claim, so a terminal
      // observer's delayed report cannot erase a session that is really
      // blocked on something a device can answer (ADR-0002).
      { state: state.state, task: displayTask, claim: approvalClaim(state, Date.now()) },
      { id: `daemon-state:${agentId}:${stateFingerprint}`, seq },
    )
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
      cwd: state.cwd,
      model:
        state.model ??
        (runtime === "claude" ? "Claude Code" : runtime === "gemini" ? "Gemini CLI" : "Codex"),
      runtime,
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
// The fast path: hook shims hand their events here instead of loading the
// module graph themselves. serveHookSocket serialises requests, and the
// handler reloads the state file per event, so a served stream reads exactly
// like the one-process-per-hook sequence it replaces.
const socketServer = serveHookSocket(socketPath, async (request) => {
  const result = await handleHookEvent({
    runtime:
      request.runtime === "codex" ? "codex" : request.runtime === "gemini" ? "gemini" : "claude",
    expectedEvent: request.expectedEvent,
    payloadText: request.payload,
    hookCwd: request.cwd,
    hookPpid: request.ppid,
  });
  const response: SocketHookResponse = { exitCode: 0 };
  if (result.stdout !== undefined) response.stdout = result.stdout;
  return response;
});
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
  socketServer.close();
  try {
    unlinkSync(pidPath);
  } catch {
    /* Already replaced or cleaned up. */
  }
}
