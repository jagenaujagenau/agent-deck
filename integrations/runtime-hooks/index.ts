#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentDeckClient,
  clip,
  clipMultiline,
  type AgentEventInput,
  type AgentState,
  type CanonicalRuntimeEvent,
  type ControlAction,
  type RuntimeEventType,
} from "../../packages/agent-adapter/src/index";
import { asString, isJsonNumber, isJsonObject, parseJson } from "./json-value";
import type { JsonValue } from "./json-value";
import {
  describeToolCall,
  type ApprovalMode,
} from "../../packages/agent-adapter/src/approval-policy";
import {
  canonicalLifecycleEvent,
  notificationIsIdle,
  shouldRequestRemoteApproval,
} from "./lifecycle";
import { projectNameForCwd } from "./project";
import {
  captureSnapshot,
  consumeSnapshot,
  mutatesFile,
  pruneSnapshots,
  readFileForDiff,
} from "../../packages/agent-adapter/src/file-snapshot";
import { unifiedDiff } from "../../packages/agent-adapter/src/unified-diff";
import {
  drainRemoteMessages,
  promptContext,
  stopHookDecision,
  type CommandQueue,
} from "./remote-messages";
import { parseHookPayload, type ToolArguments } from "./hook-input";
import {
  changedPaths,
  diffForPath,
  fingerprintWorkspace,
  type WorkspaceFingerprint,
} from "./workspace-changes";
import {
  discoverCodexSlashCommands,
  discoverGeminiSlashCommands,
  discoverSlashCommands,
} from "./slash-commands";
import { nextReportSeq, REPORT_SOURCE } from "./report-seq";

type HookState = {
  state: AgentState;
  task: string;
  objective?: string;
  name?: string;
  project?: string;
  /** Where the session works; the daemon repeats it on every heartbeat. */
  cwd?: string;
  model?: string;
  tokens?: number;
  processedTokens?: number;
  activeTurnId?: string;
  transcriptPath?: string;
  transcriptOffset?: number;
  /** What the working tree looked like after the last shell command. */
  workspace?: WorkspaceFingerprint;
  /** The report counter shared with the daemon; every runtime event advances it. */
  reportSeq?: number;
  ownerPid?: number;
  capabilities?: ControlAction[];
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

/**
 * How long a question waits for a remote answer before the host terminal takes over. The tool's own
 * prompt cannot appear until this hook returns, so a long window hides the question from whoever is
 * sitting at the terminal. Keep it short by default; raise it when nobody is at the machine, or set
 * it to 0 to never wait and answer locally as before.
 */
const QUESTION_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.AGENT_DECK_QUESTION_TIMEOUT_MS ?? 30_000) || 0,
);
const runtime =
  process.argv[2] === "codex" ? "codex" : process.argv[2] === "gemini" ? "gemini" : "claude";
const expectedEvent = process.argv[3] ?? "";
const inputText = await Bun.stdin.text();
const input = parseHookPayload(inputText);
const event = canonicalLifecycleEvent(input.eventName ?? expectedEvent);
const cwd = input.cwd ?? process.cwd();
const sessionSeed = input.sessionId ?? `${cwd}:${input.transcriptPath ?? process.ppid}`;
const sessionKey = createHash("sha256").update(String(sessionSeed)).digest("hex").slice(0, 24);
const agentId = `${runtime}-${sessionKey}`;
const stateDirectory = join(homedir(), ".cache", "agent-deck", "runtime-hooks");
const snapshotDirectory = join(stateDirectory, "snapshots");
const statePath = join(stateDirectory, `${agentId}.json`);
const client = new AgentDeckClient();
/** The client as the message queue sees it: an acknowledgement's body says nothing worth reading. */
const commandQueue: CommandQueue = {
  commands: (id) => client.commands(id),
  acknowledge: async (id, commandId) => {
    await client.acknowledge(id, commandId);
  },
};
const runtimeTitle = runtime === "claude" ? "Claude" : runtime === "codex" ? "Codex" : "Gemini";
const model = runtime === "claude" ? "Claude Code" : runtime === "codex" ? "Codex" : "Gemini CLI";
const detectedProject = projectNameForCwd(cwd);
const displayName = `${runtimeTitle} · ${detectedProject} · ${sessionKey.slice(0, 4)}`;
const approvalModeSetting = process.env.AGENT_DECK_APPROVAL_MODE;
const approvalMode: ApprovalMode =
  approvalModeSetting === "off" ||
  approvalModeSetting === "destructive" ||
  approvalModeSetting === "all"
    ? approvalModeSetting
    : "destructive";

mkdirSync(stateDirectory, { recursive: true });
function runtimeOwnerPid() {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const result = Bun.spawnSync(["ps", "-o", "ppid=,command=", "-p", String(pid)]);
    const line = result.stdout.toString().trim();
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) break;
    if (match[2]!.toLowerCase().includes(runtime)) return pid;
    pid = Number(match[1]);
  }
  return process.ppid;
}

let state: HookState = { state: "idle", task: "Ready for an instruction" };
try {
  // SAFETY: the state file is this adapter's own — every writer is this hook or
  // its daemon, and both serialise exactly this shape. A corrupt file fails the
  // parse and falls through to the fresh state below.
  state = JSON.parse(readFileSync(statePath, "utf8")) as HookState;
} catch {
  /* First event for this session. */
}
state.project ??= detectedProject;
state.cwd = cwd;
state.name = `${runtimeTitle} · ${state.project} · ${sessionKey.slice(0, 4)}`;
state.ownerPid = runtimeOwnerPid();
state.capabilities = ["approve", "reject", "steer", "prompt", "follow_up"];
// The daemon tails this for reasoning between hook invocations, so it has to know where it is.
if (input.transcriptPath !== undefined) state.transcriptPath = input.transcriptPath;

function ensureDaemon() {
  const pidPath = `${statePath}.pid`;
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    process.kill(pid, 0);
    return;
  } catch {
    /* Missing or stale daemon. */
  }
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "daemon.ts"),
      agentId,
      statePath,
      state.project ?? detectedProject,
    ],
    {
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  child.unref();
  writeFileSync(pidPath, String(child.pid));
}

/** One assistant turn's usage, as a Claude Code transcript line reports it. */
type ClaudeUsageLine = {
  /** Deduplication key: message id and request id, or a hash of the raw line when both are absent. */
  key: string;
  model?: string;
  contextTokens: number;
};

/** Throws on a malformed line, exactly as the raw JSON.parse it replaces did. */
function parseClaudeUsageLine(line: string): ClaudeUsageLine | undefined {
  const entry = parseJson(line);
  if (!isJsonObject(entry) || entry.type !== "assistant") return undefined;
  const message = isJsonObject(entry.message) ? entry.message : undefined;
  const usage = message !== undefined && isJsonObject(message.usage) ? message.usage : undefined;
  if (message === undefined || usage === undefined) return undefined;
  const id = asString(message.id);
  const requestId = asString(entry.requestId);
  const count = (field: string) => {
    const value = usage[field];
    return isJsonNumber(value) ? value : 0;
  };
  return {
    key:
      id || requestId
        ? `${id ?? ""}:${requestId ?? ""}`
        : createHash("sha1").update(line).digest("hex"),
    model: asString(message.model),
    contextTokens:
      count("input_tokens") +
      count("cache_creation_input_tokens") +
      count("cache_read_input_tokens") +
      count("output_tokens"),
  };
}

/** One of Codex's rate-limit windows, as a token_count event reports it. */
type CodexRateWindow = { usedPercent: number; windowMinutes?: number; resetsAt?: number };

/** A Codex token_count event: cumulative and last-turn usage plus whatever windows it carried. */
type CodexUsageLine = {
  contextTokens?: number;
  processedTokens?: number;
  /** Present windows in primary-then-secondary order, which is what names them downstream. */
  windows: CodexRateWindow[];
  planType?: string;
};

/** Throws on a malformed line, exactly as the raw JSON.parse it replaces did. */
function parseCodexUsageLine(line: string): CodexUsageLine | undefined {
  const entry = parseJson(line);
  if (!isJsonObject(entry) || entry.type !== "event_msg") return undefined;
  const payload = isJsonObject(entry.payload) ? entry.payload : undefined;
  if (payload === undefined || payload.type !== "token_count") return undefined;
  const info = isJsonObject(payload.info) ? payload.info : undefined;
  const totalTokens = (value: JsonValue | undefined) => {
    const total = isJsonObject(value) ? value.total_tokens : undefined;
    return isJsonNumber(total) ? total : undefined;
  };
  const limits = isJsonObject(payload.rate_limits) ? payload.rate_limits : undefined;
  const window = (value: JsonValue | undefined): CodexRateWindow | undefined => {
    if (!isJsonObject(value)) return undefined;
    const parsed: CodexRateWindow = {
      usedPercent: isJsonNumber(value.used_percent) ? value.used_percent : 0,
    };
    if (isJsonNumber(value.window_minutes)) parsed.windowMinutes = value.window_minutes;
    if (isJsonNumber(value.resets_at)) parsed.resetsAt = value.resets_at;
    return parsed;
  };
  return {
    contextTokens: totalTokens(info?.last_token_usage),
    processedTokens: totalTokens(info?.total_token_usage),
    windows: [window(limits?.primary), window(limits?.secondary)].filter(
      (parsed): parsed is CodexRateWindow => parsed !== undefined,
    ),
    planType: asString(limits?.plan_type),
  };
}

function updateUsageFromTranscript() {
  if (input.transcriptPath === undefined) return;
  // Gemini's conversation file is one JSON document, not a JSONL of usage
  // entries; neither parser below can read a token count out of it.
  if (runtime === "gemini") return;
  try {
    const lines = readFileSync(input.transcriptPath, "utf8").split("\n").filter(Boolean);
    if (runtime === "claude") {
      const seen = new Set<string>();
      let processedTokens = 0;
      let contextTokens = 0;
      for (const line of lines) {
        const entry = parseClaudeUsageLine(line);
        if (!entry || seen.has(entry.key)) continue;
        seen.add(entry.key);
        state.model = entry.model ?? state.model;
        contextTokens = entry.contextTokens;
        processedTokens += contextTokens;
      }
      state.tokens = contextTokens;
      state.processedTokens = processedTokens;
      return;
    }
    for (const line of lines.reverse()) {
      const entry = parseCodexUsageLine(line);
      if (!entry) continue;
      state.tokens = entry.contextTokens ?? state.tokens;
      state.processedTokens = entry.processedTokens ?? state.processedTokens;
      const label = (minutes?: number) =>
        !minutes
          ? "Usage"
          : minutes % 10_080 === 0
            ? `${minutes / 10_080}w`
            : minutes % 60 === 0
              ? `${minutes / 60}h`
              : `${minutes}m`;
      state.rateLimits = entry.windows.map((window, index) => ({
        id: index === 0 ? "primary" : "secondary",
        label: label(window.windowMinutes),
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : undefined,
        account: entry.planType,
      }));
      break;
    }
  } catch {
    /* Transcript may not exist yet during early lifecycle hooks. */
  }
}

const heartbeat = async () =>
  client.heartbeat({
    id: agentId,
    name: state.name ?? displayName,
    project: state.project ?? detectedProject,
    cwd: state.cwd ?? cwd,
    model: state.model ?? model,
    runtime,
    runtimeProtocol: "canonical-v1",
    state: state.state,
    task: state.task,
    objective: state.objective,
    tokens: state.tokens,
    processedTokens: state.processedTokens,
    capabilities: state.capabilities,
    rateLimits: state.rateLimits,
    pendingApproval: state.pendingApproval,
  });
const save = () => writeFileSync(statePath, JSON.stringify(state));
/** Everything a runtime event of this adapter's ever says about itself. */
type RuntimePayload = Record<string, string | number | boolean | string[] | undefined>;
const publishRuntime = (
  type: RuntimeEventType,
  payload: RuntimePayload,
  refs: { id?: string; turnId?: string; itemId?: string; requestId?: string } = {},
) => {
  // The daemon publishes state reports for this session too, so every report
  // carries the shared counter — one total order per session, whichever
  // process spoke. Persisted before the wire: a report that went out must
  // never be re-numbered by the next one.
  const seq = nextReportSeq(statePath, state);
  save();
  const runtimeEvent: CanonicalRuntimeEvent = {
    id: refs.id ?? crypto.randomUUID(),
    agentId,
    type,
    createdAt: new Date().toISOString(),
    origin: { source: REPORT_SOURCE, seq },
    payload,
  };
  if (refs.turnId) runtimeEvent.turnId = refs.turnId;
  if (refs.itemId) runtimeEvent.itemId = refs.itemId;
  if (refs.requestId) runtimeEvent.requestId = refs.requestId;
  return client.runtimeEvent(runtimeEvent);
};
const publish = (
  kind: "thought" | "tool" | "output" | "warning" | "error" | "question" | "user",
  summary: string,
  detail?: string,
  extra: {
    id?: string;
    tool?: string;
    path?: string;
    command?: string;
    diff?: string;
    options?: string[];
  } = {},
) => {
  const agentEvent: AgentEventInput = {
    kind,
    summary: clip(summary, 120),
    detail: detail ? clipMultiline(detail) : undefined,
    // Every event belongs to the exchange that caused it; the turn is the
    // deck's thread unit, so the id rides along wherever one is open.
    turnId: state.activeTurnId,
    ...extra,
  };
  // Claude Code tags every hook fired inside a subagent with that subagent's
  // own id and type, and this dropped both - so three subagents working at
  // once arrived as one undifferentiated stream in the parent, which is what
  // made a busy session unreadable. Absent on the parent's own calls, which
  // is exactly the distinction wanted.
  if (input.agentId) agentEvent.subagentId = input.agentId;
  if (input.agentType) agentEvent.subagentType = input.agentType;
  return client.event(agentId, agentEvent);
};

function toolTarget(toolInput: ToolArguments): string | undefined {
  const target =
    toolInput.file_path !== undefined
      ? toolInput.file_path
      : toolInput.path !== undefined
        ? toolInput.path
        : undefined;
  return target ? (target.startsWith("/") ? target : join(cwd, target)) : undefined;
}

/** Keys a snapshot to one tool call, falling back to the target path when the runtime omits an id. */
function snapshotKey(target: string) {
  return `${sessionKey}:${input.toolUseId ?? target}`;
}

/**
 * Builds the diff shown in the phone's Changes tab. When PreToolUse snapshotted the target we can
 * diff the real before/after and emit unified hunks with true line numbers; otherwise we fall back
 * to the runtime's own before/after strings, which carry no positions.
 */
function fileDiff(tool: string, toolInput: ToolArguments): string | undefined {
  const target = toolTarget(toolInput);
  if (mutatesFile(tool, target)) {
    const before = consumeSnapshot(snapshotDirectory, snapshotKey(target));
    const after = readFileForDiff(target);
    if (before !== null && after !== null) {
      const unified = unifiedDiff(before, after);
      // "" means the tool touched nothing; null means too large or too dissimilar to diff cheaply.
      if (unified === "") return undefined;
      if (unified !== null) return clipMultiline(unified, 16_000);
    }
  }
  const oldText = toolInput.old_string;
  const newText = toolInput.new_string;
  if (oldText != null && newText != null) {
    return clipMultiline(
      `- ${oldText.replace(/\n/g, "\n- ")}\n+ ${newText.replace(/\n/g, "\n+ ")}`,
      16_000,
    );
  }
  if (/write|create/i.test(tool) && toolInput.content !== undefined) {
    return clipMultiline(`+ ${toolInput.content.replace(/\n/g, "\n+ ")}`, 16_000);
  }
  return undefined;
}

async function preToolUse() {
  const toolName = input.toolName ?? "tool";
  const toolInput = input.toolArguments;
  state.state = "running";
  state.task = `Using ${toolName}`;
  if (/ask.?user.?question/i.test(toolName)) {
    const first = toolInput.questions?.[0];
    const question = first?.prompt ?? "Agent needs your answer";
    const options = first?.options ?? [];
    state.state = "waiting";
    state.task = clip(question, 180);
    const questionId = crypto.randomUUID();
    const askedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + QUESTION_TIMEOUT_MS).toISOString();
    save();
    let questionHeartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await heartbeat();
      questionHeartbeat = setInterval(() => void heartbeat().catch(() => {}), 10_000);
      // A durable request is what makes the question answerable from a device: the phone and watch
      // resolve it, and this blocked process collects the answer by polling.
      await publishRuntime(
        "user-input.requested",
        { kind: "user-input", question, options, createdAt: askedAt, expiresAt },
        {
          id: `user-input-requested:${questionId}`,
          requestId: questionId,
          turnId: state.activeTurnId,
        },
      );
      await publish("question", "Question", question, { id: questionId, tool: toolName, options });
      const answer =
        options.length > 0 && QUESTION_TIMEOUT_MS > 0
          ? await client.waitForAnswer(agentId, questionId, { timeoutMs: QUESTION_TIMEOUT_MS })
          : undefined;
      if (questionHeartbeat) clearInterval(questionHeartbeat);
      state.state = "running";
      state.pendingApproval = undefined;
      if (answer === undefined) {
        // Nobody answered remotely, so leave the tool alone and let it prompt on the host terminal.
        state.task = clip(question, 180);
        save();
        await heartbeat().catch(() => {});
        return;
      }
      state.task = clip(`Answered: ${answer}`, 180);
      save();
      await publishRuntime(
        "user-input.resolved",
        { status: "answered", value: answer },
        {
          id: `user-input-resolved:${questionId}`,
          requestId: questionId,
          turnId: state.activeTurnId,
        },
      ).catch(() => {});
      await publish("output", "Answered from Agent Deck", answer).catch(() => {});
      await heartbeat().catch(() => {});
      // A hook cannot return a tool result, but denying the call with the answer as the reason puts
      // the user's choice in front of the model instead of stalling on a local prompt it cannot see.
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `The user answered from Agent Deck: ${answer}. Do not ask again — continue with that answer.`,
          },
        }),
      );
      return;
    } catch {
      if (questionHeartbeat) clearInterval(questionHeartbeat);
      state.state = "running";
      save();
      return;
    }
  }
  if (
    !shouldRequestRemoteApproval(
      runtime,
      input.permissionMode,
      toolName,
      toolInput.raw,
      approvalMode,
    )
  ) {
    state.pendingApproval = undefined;
    save();
    await heartbeat();
    return;
  }

  const detail = describeToolCall(toolName, toolInput.raw);
  const approvalId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  state.state = "waiting";
  state.task = clip(`Approval: ${toolName} · ${detail}`, 180);
  state.pendingApproval = {
    id: approvalId,
    tool: toolName,
    detail,
    createdAt,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  save();
  let approvalHeartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await heartbeat();
    approvalHeartbeat = setInterval(() => void heartbeat().catch(() => {}), 10_000);
    await publishRuntime(
      "request.opened",
      {
        kind: "approval",
        tool: toolName,
        detail,
        createdAt,
        expiresAt: state.pendingApproval!.expiresAt,
      },
      { id: `request-opened:${approvalId}`, requestId: approvalId, turnId: state.activeTurnId },
    );
    await publish("warning", `Approval required: ${toolName}`, detail, {
      id: approvalId,
      tool: toolName,
    });
    const approved = await client.waitForDecision(agentId);
    if (approvalHeartbeat) clearInterval(approvalHeartbeat);
    state.state = approved ? "running" : "idle";
    state.task = approved ? `Approved: ${toolName}` : `Rejected: ${toolName}`;
    state.pendingApproval = undefined;
    save();
    await publishRuntime(
      "request.resolved",
      { status: approved ? "approved" : "rejected" },
      { id: `request-resolved:${approvalId}`, requestId: approvalId, turnId: state.activeTurnId },
    ).catch(() => {});
    await publish(approved ? "output" : "warning", state.task, detail);
    await heartbeat();
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: approved ? "allow" : "deny",
          permissionDecisionReason: approved
            ? "Approved from Agent Deck"
            : "Rejected or timed out in Agent Deck",
        },
      }),
    );
  } catch {
    if (approvalHeartbeat) clearInterval(approvalHeartbeat);
    state.state = "running";
    state.task = `Local approval required: ${toolName}`;
    state.pendingApproval = undefined;
    save();
    await publishRuntime(
      "request.resolved",
      { status: "unavailable" },
      { id: `request-resolved:${approvalId}`, requestId: approvalId, turnId: state.activeTurnId },
    ).catch(() => {});
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "Agent Deck is unavailable; use the local permission prompt",
        },
      }),
    );
  }
}

switch (event) {
  case "SessionStart":
    state = {
      state: "idle",
      task: "Ready for an instruction",
      name: displayName,
      project: detectedProject,
      ownerPid: runtimeOwnerPid(),
      capabilities: ["approve", "reject", "steer", "prompt", "follow_up"],
    };
    // Identity as an event, not only as a heartbeat field. The heartbeat was
    // the sole carrier of a session's name, project and model, which is the one
    // reason ADR-0001 keeps it alive; a projection that can say what a session
    // is called can stand on its own.
    await publishRuntime("session.registered", {
      name: displayName,
      project: detectedProject,
      model,
      runtime,
      capabilities: state.capabilities,
    }).catch(() => {});
    await publishRuntime("session.state.changed", { state: "idle", task: state.task }).catch(
      () => {},
    );
    // Publish what this session can be asked to run by name, so a device can offer it. Once per
    // session: it means reading a few hundred frontmatter blocks.
    await client
      .request(`/agents/${encodeURIComponent(agentId)}/slash-commands`, {
        method: "POST",
        body: JSON.stringify({
          commands:
            runtime === "codex"
              ? discoverCodexSlashCommands(join(homedir(), ".codex"))
              : runtime === "gemini"
                ? discoverGeminiSlashCommands(join(homedir(), ".gemini"))
                : discoverSlashCommands({
                  userDir: join(homedir(), ".claude"),
                  projectDir: cwd,
                  pluginManifest: join(homedir(), ".claude", "plugins", "installed_plugins.json"),
                }),
        }),
      })
      .catch(() => {});
    break;
  case "UserPromptSubmit":
    state.state = "running";
    state.objective = clip(input.prompt ?? "Received instruction", 500);
    state.task = state.objective;
    state.activeTurnId = crypto.randomUUID();
    await publishRuntime(
      "turn.started",
      { objective: state.objective },
      { turnId: state.activeTurnId },
    ).catch(() => {});
    // The prompt is the person speaking, so it goes on the wire as what it is.
    // The transcript tail republishes the same turn under its transcript id a
    // moment later; the surfaces' close-in-time fold collapses the pair, the
    // same way it already collapsed the string-typed thought this replaces.
    await publish("user", "Message", (input.prompt ?? state.task).trim(), {
      id: `user:${agentId}:${state.activeTurnId}`,
    }).catch(() => {});
    {
      // Anything queued from the app while this session sat idle has had no
      // delivery point - Stop fires at the end of a turn and an idle session
      // runs none. The user typing is the first moment one can be delivered,
      // so it joins this turn instead of waiting for the turn after it.
      const queued = await drainRemoteMessages(commandQueue, agentId).catch((): string[] => []);
      if (queued.length > 0) console.log(promptContext(queued));
    }
    break;
  case "PreToolUse": {
    // The file still holds its old contents here; snapshot it so PostToolUse can produce a real
    // diff instead of reporting the whole new file as additions.
    const target = toolTarget(input.toolArguments);
    if (mutatesFile(input.toolName ?? "", target)) {
      pruneSnapshots(snapshotDirectory);
      captureSnapshot(snapshotDirectory, snapshotKey(target), target);
    }
    save();
    ensureDaemon();
    await preToolUse();
    process.exit(0);
  }
  case "PostToolUse": {
    const tool = input.toolName ?? "Tool";
    const toolInput = input.toolArguments;
    const path = toolInput.file_path ?? toolInput.path;
    const command =
      toolInput.command !== undefined ? clipMultiline(toolInput.command, 8_000) : undefined;
    const diff = fileDiff(tool, toolInput);
    state.state = "running";
    state.task = `${tool} completed`;
    const itemId = input.toolUseId ?? crypto.randomUUID();
    // A shell command names no file, so the workspace is asked what moved. Only
    // for shell tools: every other tool carries its own target and is captured
    // above without paying for a `git status`.
    if (/^(bash|shell|run|terminal)/i.test(tool)) {
      const workspace = fingerprintWorkspace(cwd);
      if (workspace) {
        const previous = state.workspace;
        state.workspace = workspace;
        // The first shell command of a session only establishes the baseline.
        // Reporting against nothing would publish a whole dirty tree as this
        // one command's doing.
        for (const changed of previous ? changedPaths(previous, workspace) : []) {
          const body = diffForPath(cwd, changed);
          if (!body) continue;
          const absolute = join(cwd, changed);
          const summary = `${tool} changed ${changed.split("/").pop()}`;
          await publishRuntime(
            "item.completed",
            { tool, summary, path: absolute, diff: body },
            {
              id: `item-completed:${sessionKey}:${itemId}:${changed}`,
              itemId: `${itemId}:${changed}`,
              turnId: state.activeTurnId,
            },
          ).catch(() => {});
          // The runtime event feeds the projection; this is what lands the diff
          // in the session's file history, which is what the Changes tab reads.
          await publish("output", summary, undefined, {
            id: `shell-change:${sessionKey}:${itemId}:${changed}`,
            tool,
            path: absolute,
            diff: body,
          }).catch(() => {});
        }
      }
    }
    await publishRuntime(
      "item.completed",
      {
        tool,
        summary: state.task,
        detail: describeToolCall(tool, toolInput.raw),
        path,
        command,
        diff,
      },
      { id: `item-completed:${sessionKey}:${itemId}`, itemId, turnId: state.activeTurnId },
    ).catch(() => {});
    await publish("output", state.task, describeToolCall(tool, toolInput.raw), {
      id: input.toolUseId ? `tool:${sessionKey}:${input.toolUseId}` : undefined,
      tool,
      path,
      command,
      diff,
    }).catch(() => {});
    break;
  }
  case "PostToolUseFailure":
    state.state = "error";
    state.task = `${input.toolName ?? "Tool"} failed`;
    await publishRuntime(
      "runtime.error",
      { message: state.task },
      { turnId: state.activeTurnId },
    ).catch(() => {});
    await publish("error", state.task).catch(() => {});
    break;
  case "Notification": {
    const message = clip(input.message ?? input.notificationType ?? "Needs attention");
    // An approval already in flight outranks the wording: the blocked PreToolUse
    // process is genuinely holding, whatever this notification happens to say.
    const holdingApproval =
      state.pendingApproval !== undefined &&
      Date.parse(state.pendingApproval.expiresAt) > Date.now();
    if (notificationIsIdle(message) && !holdingApproval) {
      // The turn is over and Claude is back at its prompt. Said as idle rather
      // than skipped, so a session whose Stop never landed - an interrupted
      // turn, a crashed hook - still stops reading as busy. Nothing is
      // published as an event: there is nothing here for a person to answer.
      state.state = "idle";
      state.task = "Ready for an instruction";
      await publishRuntime("session.state.changed", { state: "idle", task: state.task }).catch(
        () => {},
      );
      break;
    }
    state.state = "waiting";
    state.task = message;
    await publishRuntime("session.state.changed", { state: "waiting", task: state.task }).catch(
      () => {},
    );
    await publish("warning", "Needs attention", state.task).catch(() => {});
    break;
  }
  case "SubagentStop": {
    // A subagent finishing is work completed *inside* the turn, never the turn
    // itself ending - so the state is deliberately left alone. Marking the
    // session idle here would report the parent as done while it is still
    // collecting results, which is the whole reason this event was worth adding.
    const kind = input.agentType ?? "Subagent";
    state.task = clip(`${kind} subagent finished`, 180);
    // Claude Code hands us the parent's session id and the subagent's own id as
    // separate fields, so the subagent is reportable without deriving a second
    // session from it. The subagent id is the item id: re-publishing the same
    // completion collapses at the bridge instead of arriving twice.
    const itemId = input.agentId ?? crypto.randomUUID();
    await publishRuntime(
      "item.completed",
      { tool: "Task", summary: state.task, detail: input.lastAssistantMessage },
      { id: `subagent-completed:${sessionKey}:${itemId}`, itemId, turnId: state.activeTurnId },
    ).catch(() => {});
    await publish("output", state.task, input.lastAssistantMessage, {
      id: `subagent:${sessionKey}:${itemId}`,
      tool: "Task",
    }).catch(() => {});
    break;
  }
  case "StopFailure":
    state.state = "error";
    state.task = "Response failed";
    await publish("error", state.task, input.lastAssistantMessage).catch(() => {});
    break;
  case "Stop":
    updateUsageFromTranscript();
    state.state = "idle";
    state.task = clip(input.lastAssistantMessage ?? "Turn completed");
    await publishRuntime(
      "token-usage.updated",
      {
        contextTokens: state.tokens ?? 0,
        processedTokens: state.processedTokens ?? state.tokens ?? 0,
      },
      { turnId: state.activeTurnId },
    ).catch(() => {});
    await publishRuntime(
      "turn.completed",
      { status: "completed", summary: state.task },
      { turnId: state.activeTurnId },
    ).catch(() => {});
    // For Claude and Codex the response is not published here: the daemon
    // republishes it from the transcript with an id derived from the
    // transcript uuid, which is what lets a re-publish collapse at the bridge.
    // Gemini has no transcript tail yet, but its AfterAgent hook hands the
    // response over directly — published under a turn-derived id so a re-fire
    // collapses the same way.
    if (runtime === "gemini" && input.lastAssistantMessage?.trim()) {
      await publish("output", "Response", input.lastAssistantMessage, {
        id: `chat:${agentId}:${state.activeTurnId ?? "turn"}:response`,
      }).catch(() => {});
    }
    state.activeTurnId = undefined;
    {
      // A hook cannot type into a running session, but blocking the Stop hook keeps the turn alive
      // and hands `reason` back to the model as its next instruction. That is the delivery point
      // for anything the phone queued while this turn was running.
      const messages = await drainRemoteMessages(commandQueue, agentId).catch((): string[] => []);
      if (messages.length > 0) {
        state.state = "running";
        state.objective = clip(messages.join("\n\n"), 500);
        state.task = state.objective;
        state.activeTurnId = crypto.randomUUID();
        save();
        // stdout before the network: the message is already acknowledged, so a bridge hiccup here
        // must not be what loses it.
        console.log(stopHookDecision(messages));
        await publishRuntime(
          "turn.started",
          { objective: state.objective },
          { turnId: state.activeTurnId },
        ).catch(() => {});
        ensureDaemon();
        await heartbeat().catch(() => {});
        process.exit(0);
      }
    }
    break;
  case "SessionEnd":
    updateUsageFromTranscript();
    state.state = "offline";
    state.task = "Session ended";
    await publishRuntime("session.state.changed", { state: "offline", task: state.task }).catch(
      () => {},
    );
    break;
  default:
    state.task = clip(event || "Runtime event");
}
save();
if (event !== "SessionEnd") ensureDaemon();
await heartbeat().catch(() => {});
