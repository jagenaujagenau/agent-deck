import { AgentDeckClient } from "../../packages/agent-adapter/src/client";
import type { RuntimeEventType } from "../../packages/agent-adapter/src/runtime-events";
import { drainRemoteMessages, promptContext } from "../runtime-hooks/remote-messages";
import { listAgents, promptAgent, readPane, sendKeys } from "./herdr-cli";
import { parsePrompt, type TerminalPrompt } from "./prompt";
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
 *
 * Everything here is published as canonical Runtime Events. An earlier version
 * wrote corrections into the hooks' private state files, because the bridge
 * discarded any projection that disagreed with a heartbeat and an event could
 * not move a session on its own. With that gate gone (ADR-0001), one
 * integration no longer has to reach into another's on-disk state to launder a
 * fact through a third component.
 */

const POLL_INTERVAL_MS = Number(process.env.AGENT_DECK_HERDR_INTERVAL_MS ?? 4_000) || 4_000;
/** Long enough for a person to reach a wrist, short enough to expire honestly. */
const ANSWER_TIMEOUT_MS = 10 * 60_000;

const client = new AgentDeckClient();

/** Requests opened for a terminal prompt, so one screen opens one request. */
const openRequests = new Map<string, string>();

/**
 * Sessions this integration has put into `waiting`.
 *
 * In memory because a restart should forget: Herdr will report the pane blocked
 * again on the next pass and the claim is remade. A claim that outlived the
 * process would be one nothing could withdraw.
 */
const claimed = new Set<string>();

interface DeckAgent {
  id: string;
  state: string;
  task: string;
  pendingApproval?: unknown;
}

/** What the bridge currently believes, which is what corrections are made against. */
async function deckAgents(): Promise<Map<string, DeckAgent>> {
  const snapshot = await client
    .request<{ agents: ReadonlyArray<DeckAgent> }>("/snapshot")
    .catch(() => undefined);
  return new Map((snapshot?.agents ?? []).map((agent) => [agent.id, agent]));
}

const publish = (
  agentId: string,
  type: RuntimeEventType,
  payload: Record<string, unknown>,
  id?: string,
) =>
  client
    .runtimeEvent({
      id: id ?? crypto.randomUUID(),
      agentId,
      type,
      createdAt: new Date().toISOString(),
      payload,
    })
    .catch(() => {});

/**
 * Waits for an answer and presses it, then lets the screen speak for itself.
 *
 * Keys rather than text: Herdr refuses to submit a prompt to a blocked agent,
 * and blocked is the only state this ever runs in. The number is typed and
 * confirmed exactly as a person sitting there would.
 */
async function awaitAnswer(
  agentId: string,
  requestId: string,
  target: string,
  prompt: TerminalPrompt,
) {
  const answer = await client
    .waitForAnswer(agentId, requestId, { timeoutMs: ANSWER_TIMEOUT_MS })
    .catch(() => undefined);
  openRequests.delete(agentId);

  if (answer === undefined) {
    // Nobody answered. The terminal is still waiting, and saying so is better
    // than leaving a resolved-looking request behind.
    await publish(agentId, "user-input.resolved", { status: "expired" });
    return;
  }

  // A device sends back the label it was shown; the terminal wants the number.
  const chosen =
    prompt.options.find((option) => option.label === answer) ??
    prompt.options.find((option) => String(option.number) === answer.trim());
  if (chosen === undefined) {
    await publish(agentId, "user-input.resolved", { status: "unavailable", value: answer });
    return;
  }

  const pressed = await sendKeys(target, [String(chosen.number), "enter"]).catch(() => false);
  await publish(agentId, "user-input.resolved", {
    status: pressed ? "answered" : "unavailable",
    value: chosen.label,
  });
  if (pressed) {
    await publish(agentId, "session.state.changed", { state: "running", task: chosen.label });
  }
}

/**
 * Turns a blocked pane into something a watch can answer.
 *
 * When the screen cannot be read as a question, the session is still reported
 * as waiting - knowing that something is stuck is worth more than nothing, even
 * when the deck cannot say what it wants.
 */
async function claimBlocked(agent: HerdrAgent, agentId: string) {
  const prompt = parsePrompt(await readPane(agent.target).catch(() => ""));
  if (prompt === undefined) {
    await publish(agentId, "session.state.changed", {
      state: "waiting",
      task: TERMINAL_PROMPT_TASK,
    });
    return;
  }

  await publish(agentId, "session.state.changed", { state: "waiting", task: prompt.question });
  if (openRequests.has(agentId)) return;

  const requestId = crypto.randomUUID();
  openRequests.set(agentId, requestId);
  await client
    .runtimeEvent({
      id: `terminal-prompt:${requestId}`,
      agentId,
      type: "user-input.requested",
      createdAt: new Date().toISOString(),
      requestId,
      payload: {
        kind: "user-input",
        question: prompt.question,
        options: prompt.options.map((option) => option.label),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ANSWER_TIMEOUT_MS).toISOString(),
      },
    })
    .catch(() => openRequests.delete(agentId));

  void awaitAnswer(agentId, requestId, agent.target, prompt);
}

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
  const known = await deckAgents();

  for (const agent of agents) {
    if (!isDeckRuntime(agent.kind)) continue;
    const agentId = deckAgentId(agent.kind, agent.sessionId);
    const deck = known.get(agentId);
    // A terminal the deck has never seen is not part of the deck.
    if (deck === undefined) continue;

    const correction = correctionFor(agent.status, {
      state: deck.state,
      holdingApproval: deck.pendingApproval != null,
      claimedByUs: claimed.has(agentId),
    });
    if (correction === "block") {
      claimed.add(agentId);
      await claimBlocked(agent, agentId);
    } else if (correction === "clear") {
      claimed.delete(agentId);
      openRequests.delete(agentId);
      await publish(agentId, "session.state.changed", {
        state: "idle",
        task: "Ready for an instruction",
      });
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
