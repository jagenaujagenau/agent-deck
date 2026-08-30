import { createHash } from "node:crypto";
import { AgentDeckClient } from "../../packages/agent-adapter/src/client";
import type { RuntimeEventType } from "../../packages/agent-adapter/src/runtime-events";
import type { RuntimeEventPayload } from "../../packages/agent-adapter/src/runtime-publisher";
import { drainRemoteMessages, promptContext } from "../runtime-hooks/remote-messages";
import { listAgents, promptAgent, readPane, sendKeys } from "./herdr-cli";
import { liveChoice, parsePrompt, type TerminalPrompt } from "./prompt";
import { agentIdFor } from "../../packages/agent-adapter/src/agent-identity";
import {
  acceptsPrompt,
  correctionFor,
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

/**
 * Questions already put to a person, whether or not they answered.
 *
 * Without this the loop eats itself: the request id is derived from the screen,
 * so a second pass reuses it, finds it already settled, resolves it again - and
 * a resolution projects to "running", which reads as the claim having been lost
 * and starts the whole thing over. It ran four times a second and produced 468
 * resolutions in an hour for prompts nobody had touched.
 *
 * Asked once per distinct screen. Forgotten when the prompt clears, so the same
 * question appearing again later is a new question.
 */
const asked = new Set<string>();

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

const publisher = client.publisher("herdr");

const publish = (agentId: string, type: RuntimeEventType, payload: RuntimeEventPayload) =>
  publisher(agentId, type, payload).catch(() => {});

/**
 * Waits for an answer and presses it, then lets the screen speak for itself.
 *
 * Keys rather than text: Herdr refuses to submit a prompt to a blocked agent,
 * and blocked is the only state this ever runs in. The number is typed and
 * confirmed exactly as a person sitting there would — after checking, exactly
 * as a person would, that the screen still shows the question the answer was
 * given to.
 */
async function awaitAnswer(agentId: string, requestId: string, prompt: TerminalPrompt) {
  const answer = await client
    .waitForAnswer(agentId, requestId, { timeoutMs: ANSWER_TIMEOUT_MS })
    .catch(() => undefined);
  openRequests.delete(agentId);

  if (answer === undefined) {
    // Nobody answered within the window. Nothing is published: a resolution
    // projects to "running", and announcing one for a prompt still sitting on
    // screen would say the session had resumed when it has not.
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

  // The answer is minutes old and keys land on whatever the pane holds now.
  // Re-resolve which pane this session lives in — the one it was read from
  // may have been recycled — and re-read the screen; the keys are pressed
  // only against the same question, at its live numbering.
  const live = (await listAgents().catch((): ReadonlyArray<HerdrAgent> => [])).find(
    (candidate) =>
      isDeckRuntime(candidate.kind) && agentIdFor(candidate.kind, candidate.sessionId) === agentId,
  );
  const screen =
    live === undefined ? undefined : parsePrompt(await readPane(live.target).catch(() => ""));
  const press = liveChoice(prompt, screen, chosen.label);
  if (live === undefined || press === undefined) {
    await publish(agentId, "user-input.resolved", { status: "unavailable", value: chosen.label });
    return;
  }

  const pressed = await sendKeys(live.target, [String(press.number), "enter"]).catch(() => false);
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
  // The claim keeps the hooks' delayed state reports from overwriting what
  // the terminal plainly shows: hooks fire on tool calls and questions, never
  // on the runtime's own UI, so while a prompt sits on screen their view of
  // the session is structurally behind this one. Released by publishing
  // without a claim (the clear pass, the answered prompt), or by the clock if
  // this process dies holding it.
  const claim = { ttlMs: ANSWER_TIMEOUT_MS };
  const prompt = parsePrompt(await readPane(agent.target).catch(() => ""));
  if (prompt === undefined) {
    await publish(agentId, "session.state.changed", {
      state: "waiting",
      task: TERMINAL_PROMPT_TASK,
      claim,
    });
    return;
  }

  await publish(agentId, "session.state.changed", {
    state: "waiting",
    task: prompt.question,
    claim,
  });
  if (openRequests.has(agentId)) return;

  // Derived from the session and the question rather than random, so the same
  // screen always names the same request. The in-memory guard above forgets on
  // restart, and a random id turned eight blocked sessions into twenty-eight
  // pending questions across a few service restarts. A stable id collapses at
  // the bridge instead.
  const requestId = `${agentId}:${createHash("sha1").update(prompt.question).digest("hex").slice(0, 12)}`;
  if (asked.has(requestId)) return;
  asked.add(requestId);
  openRequests.set(agentId, requestId);
  await publisher(
    agentId,
    "user-input.requested",
    {
      kind: "user-input",
      question: prompt.question,
      options: prompt.options.map((option) => option.label),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ANSWER_TIMEOUT_MS).toISOString(),
    },
    { id: `terminal-prompt:${requestId}`, requestId },
  ).catch(() => openRequests.delete(agentId));

  void awaitAnswer(agentId, requestId, prompt);
}

/** Hands a session's queued messages to Herdr, which types them into its pane. */
async function deliver(agent: HerdrAgent, agentId: string) {
  // Draining acknowledges each message before delivering it, so a message cannot
  // be sent twice even if a Stop hook drains the same queue at the same moment:
  // whichever acknowledges first is the one that delivers.
  const messages = await drainRemoteMessages(client, agentId).catch((): string[] => []);
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
    const agentId = agentIdFor(agent.kind, agent.sessionId);
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
      // The screen has moved on, so the same question appearing later is a new
      // one worth putting to someone again.
      for (const id of asked) if (id.startsWith(`${agentId}:`)) asked.delete(id);
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
