import type { HerdrAgent, HerdrStatus } from "./reconcile";

/**
 * Talking to Herdr through its CLI rather than its socket.
 *
 * The CLI is the documented, versioned surface and it already speaks JSON; the
 * socket protocol is an implementation detail that would have to be tracked.
 * Every call is a fresh process, which is affordable at one poll per few seconds
 * and means a hung Herdr cannot wedge this loop.
 */

const STATUSES = new Set<string>(["idle", "working", "blocked", "done", "unknown"]);

function asStatus(value: unknown): HerdrStatus {
  return typeof value === "string" && STATUSES.has(value) ? (value as HerdrStatus) : "unknown";
}

async function run(args: ReadonlyArray<string>, timeoutMs: number) {
  const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  } finally {
    clearTimeout(timer);
  }
}

/** Every agent Herdr currently manages. Returns empty when Herdr is not running. */
export async function listAgents(timeoutMs = 5_000): Promise<ReadonlyArray<HerdrAgent>> {
  const { stdout, code } = await run(["agent", "list"], timeoutMs);
  if (code !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const agents = (parsed as { result?: { agents?: ReadonlyArray<Record<string, unknown>> } })
    ?.result?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((agent) => {
    const session = agent.agent_session as { value?: unknown } | undefined;
    const sessionId = typeof session?.value === "string" ? session.value : undefined;
    const kind = typeof agent.agent === "string" ? agent.agent : undefined;
    const target = typeof agent.pane_id === "string" ? agent.pane_id : undefined;
    // An agent Herdr cannot identify by session is one this integration has no
    // way to name on the deck, so it is skipped rather than guessed at.
    if (!sessionId || !kind || !target) return [];
    return [{ kind, sessionId, target, status: asStatus(agent.agent_status) }];
  });
}

/**
 * The pane's visible contents.
 *
 * The only way to see a runtime's own UI. A hook fires for tool calls and
 * questions the runtime routes through its API; a "Resume from summary" box is
 * drawn on a screen and announced to nobody.
 */
export async function readPane(target: string, timeoutMs = 5_000): Promise<string> {
  const { stdout, code } = await run(["agent", "read", target], timeoutMs);
  return code === 0 ? stdout : "";
}

/**
 * Presses keys in a pane.
 *
 * Not `agent prompt`, which Herdr refuses for a blocked agent - and blocked is
 * exactly when a question needs answering. Keys are what a person would press.
 */
export async function sendKeys(
  target: string,
  keys: ReadonlyArray<string>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const { code } = await run(["agent", "send-keys", target, ...keys], timeoutMs);
  return code === 0;
}

/**
 * Submits text to an agent, returning whether Herdr accepted it.
 *
 * Herdr refuses a blocked agent with `agent_blocked` before sending any input,
 * which is the guarantee that matters here: a message meant for an idle session
 * can never be typed into an approval prompt that appeared in the meantime.
 */
export async function promptAgent(
  target: string,
  text: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const { code } = await run(["agent", "prompt", target, text], timeoutMs);
  return code === 0;
}
