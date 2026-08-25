import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentDeckClient } from "../../packages/agent-adapter/src/index";
import { drainRemoteMessages, promptContext } from "../runtime-hooks/remote-messages";
import { listAgents, promptAgent } from "./herdr-cli";
import {
  acceptsPrompt,
  correctionFor,
  deckAgentId,
  isDeckRuntime,
  TERMINAL_PROMPT_TASK,
  type HerdrAgent,
} from "./reconcile";

/**
 * Bridges Herdr's view of the terminal into the deck.
 *
 * One process for every session rather than one per session: Herdr reports all
 * of its agents in a single call, so a per-session daemon would multiply the
 * same poll by the number of sessions open to learn the same thing.
 */

const POLL_INTERVAL_MS = Number(process.env.AGENT_DECK_HERDR_INTERVAL_MS ?? 4_000) || 4_000;
const STATE_DIRECTORY = join(homedir(), ".cache", "agent-deck", "runtime-hooks");

const client = new AgentDeckClient();

interface HookState {
  state?: string;
  task?: string;
  pendingApproval?: { expiresAt?: string };
  [key: string]: unknown;
}

/**
 * Reads a session's recorded state, or nothing if the deck does not know it.
 *
 * The hooks write one file per session they manage, so a missing file is the
 * local answer to "is this terminal part of the deck at all" - Herdr manages
 * plenty that are not.
 */
function readHookState(agentId: string): HookState | undefined {
  try {
    return JSON.parse(readFileSync(join(STATE_DIRECTORY, `${agentId}.json`), "utf8")) as HookState;
  } catch {
    return undefined;
  }
}

function applyCorrection(agentId: string, correction: "block" | "clear") {
  // Re-read immediately before writing: a hook may have written this file while
  // the Herdr call was in flight, and this pass only means to change two fields.
  const current = readHookState(agentId);
  if (current === undefined) return false;
  const next =
    correction === "block"
      ? { ...current, state: "waiting", task: TERMINAL_PROMPT_TASK }
      : { ...current, state: "idle", task: "Ready for an instruction" };
  try {
    writeFileSync(join(STATE_DIRECTORY, `${agentId}.json`), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

const holdingApproval = (stored: HookState) =>
  stored.pendingApproval?.expiresAt !== undefined &&
  Date.parse(stored.pendingApproval.expiresAt) > Date.now();

/** Hands a session's queued messages to Herdr, which types them into its pane. */
async function deliver(agent: HerdrAgent, agentId: string) {
  // Draining acknowledges each message before delivering it, so a message cannot
  // be sent twice even if a Stop hook drains the same queue at the same moment:
  // whichever acknowledges first is the one that delivers.
  const messages = await drainRemoteMessages(client, agentId).catch(() => [] as string[]);
  if (messages.length === 0) return;
  const text = promptContext(messages);
  const delivered = await promptAgent(agent.target, text).catch(() => false);
  if (delivered) return;
  // Herdr refused, most likely because the session became blocked between the
  // listing and the send. The messages are already acknowledged, so say where
  // they went rather than letting them disappear.
  await client
    .event(agentId, {
      kind: "warning",
      summary: "Message could not be delivered to the terminal",
      detail: text,
    })
    .catch(() => {});
}

async function pass() {
  const agents = await listAgents().catch(() => []);
  for (const agent of agents) {
    if (!isDeckRuntime(agent.kind)) continue;
    const agentId = deckAgentId(agent.kind, agent.sessionId);
    const stored = readHookState(agentId);
    if (stored === undefined) continue;

    const correction = correctionFor(agent.status, {
      state: String(stored.state ?? ""),
      task: String(stored.task ?? ""),
      holdingApproval: holdingApproval(stored),
    });
    if (correction) applyCorrection(agentId, correction);

    if (acceptsPrompt(agent.status)) await deliver(agent, agentId);
  }
}

async function main() {
  for (;;) {
    await pass().catch(() => {});
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

if (import.meta.main) void main();
