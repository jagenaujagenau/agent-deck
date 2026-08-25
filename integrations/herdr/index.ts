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
 * Reads a session's recorded state, or nothing if there is no state file.
 *
 * Only the hook runtimes write one. A plugin runtime like OpenCode reports
 * straight from its own process and keeps no file here, so an absent file is
 * not the same as an unknown session - see `knownToDeck`.
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

/**
 * The agents the bridge is actually holding.
 *
 * A state file used to stand in for this, which was true only while every
 * adapter was a hook. OpenCode reports from inside its own process and writes
 * no file, so asking the bridge is the question that was always meant: does the
 * deck know this session, whatever put it there.
 */
async function knownToDeck(): Promise<ReadonlySet<string>> {
  const snapshot = await client
    .request<{ agents: ReadonlyArray<{ id: string }> }>("/snapshot")
    .catch(() => undefined);
  return new Set(snapshot?.agents.map((agent) => agent.id) ?? []);
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
  if (agents.length === 0) return;
  const known = await knownToDeck();

  for (const agent of agents) {
    if (!isDeckRuntime(agent.kind)) continue;
    const agentId = deckAgentId(agent.kind, agent.sessionId);
    if (!known.has(agentId)) continue;

    // Only a hook runtime has a file to correct. A plugin runtime describes its
    // own state from inside the process, where it can see more than Herdr can,
    // so there is nothing here worth overruling.
    const stored = readHookState(agentId);
    if (stored !== undefined) {
      const correction = correctionFor(agent.status, {
        state: String(stored.state ?? ""),
        task: String(stored.task ?? ""),
        holdingApproval: holdingApproval(stored),
      });
      if (correction) applyCorrection(agentId, correction);
    }

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
