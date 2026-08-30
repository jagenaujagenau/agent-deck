/**
 * Measures the bridge where a phone would feel it.
 *
 * Starts a private bridge on a scratch database, then reports four numbers
 * that decide whether the deck feels instant or sluggish:
 *
 *   1. heartbeat ingest      — how fast runtimes can report in
 *   2. event ingest          — how fast a busy session can narrate itself
 *   3. snapshot read         — what a device pays to (re)connect
 *   4. SSE push latency      — event posted → patch frame on the wire,
 *                              the number that is the whole product
 *
 * Run: bun run scripts/bench-bridge.ts
 * The scratch bridge listens on a private port and is torn down on exit;
 * nothing touches local.db or the deployed bridge.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3177;
const BASE = `http://127.0.0.1:${PORT}/bridge/v1`;
const AGENTS = 50;
const EVENTS_PER_KIND = 300;
const SSE_SAMPLES = 50;

const scratch = mkdtempSync(join(tmpdir(), "bridge-bench-"));

const server = Bun.spawn(["bun", "apps/server/src/effect/main.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: {
    ...process.env,
    DATABASE_URL: `file:${join(scratch, "bench.db")}`,
    PORT: String(PORT),
    BRIDGE_NAME: "bench",
  },
  stdout: "ignore",
  stderr: "pipe",
});

// Drained continuously so the bridge can never block on a full pipe, and kept
// so a mid-benchmark crash has something to say.
let serverStderr = "";
(async () => {
  for await (const chunk of server.stderr) serverStderr += new TextDecoder().decode(chunk);
})();
server.exited.then((code) => {
  if (code !== 0 && code !== null) {
    console.error(`bridge exited with code ${code} mid-benchmark\n${serverStderr}`);
  }
});

const cleanup = () => {
  server.kill();
  rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", cleanup);

async function waitForBridge() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await Bun.sleep(100);
  }
  throw new Error(`bridge did not come up on :${PORT}\n${serverStderr}`);
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

type Stats = { p50: number; p95: number; p99: number; max: number; perSecond: number };

/** Times `total` calls, `concurrency` in flight at once, wall-clocked as a whole. */
async function measure(
  total: number,
  concurrency: number,
  call: (index: number) => Promise<Response>,
): Promise<Stats> {
  const latencies: number[] = [];
  const started = performance.now();
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const index = next++;
      const begin = performance.now();
      const response = await call(index);
      if (!response.ok) throw new Error(`call ${index} answered ${response.status}`);
      await response.arrayBuffer();
      latencies.push(performance.now() - begin);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wall = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    p99: quantile(latencies, 0.99),
    max: latencies[latencies.length - 1] ?? 0,
    perSecond: total / wall,
  };
}

const heartbeat = (index: number, task: string) =>
  fetch(`${BASE}/agents/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: `bench-agent-${index % AGENTS}`,
      name: `bench ${index % AGENTS}`,
      project: "bench",
      model: "bench-model",
      state: "running",
      task,
    }),
  });

/** Reads the body out, so the pooled socket is left clean for reuse. */
const drained = async (pending: Promise<Response>) => {
  const response = await pending;
  await response.arrayBuffer();
  return response;
};

/**
 * One SSE round trip: with a subscribed reader already caught up, post an
 * event and clock the arrival of the next patch frame.
 */
async function sseLatency(samples: number): Promise<Stats> {
  const controller = new AbortController();
  // The load phases leave pooled connections behind, and reusing one the
  // server has since dropped resets exactly one fetch. A second attempt gets
  // a fresh socket; a real client subscribes before any load exists.
  const subscribe = () => fetch(`${BASE}/events`, { signal: controller.signal });
  const response = await subscribe().catch(subscribe);
  if (!response.ok || response.body === null) throw new Error("could not subscribe to /events");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const nextFrame = async (event: string) => {
    while (true) {
      const separator = buffered.indexOf("\n\n");
      if (separator !== -1) {
        const frame = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        if (frame.includes(`event: ${event}`)) return;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended mid-benchmark");
      buffered += decoder.decode(value, { stream: true });
    }
  };

  await nextFrame("snapshot");
  const latencies: number[] = [];
  const started = performance.now();
  for (let sample = 0; sample < samples; sample++) {
    const begin = performance.now();
    // A state change every device renders: the agent's task line moves.
    await drained(heartbeat(sample, `sse round ${sample}`));
    await nextFrame("patch");
    latencies.push(performance.now() - begin);
  }
  const wall = (performance.now() - started) / 1000;
  controller.abort();
  latencies.sort((a, b) => a - b);
  return {
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    p99: quantile(latencies, 0.99),
    max: latencies[latencies.length - 1] ?? 0,
    perSecond: samples / wall,
  };
}

/** One subscribed device: a frame parser over a held-open /events response. */
async function subscriber(): Promise<{
  nextFrame: (event: string) => Promise<void>;
  stop: () => void;
}> {
  const controller = new AbortController();
  const subscribe = () => fetch(`${BASE}/events`, { signal: controller.signal });
  const response = await subscribe().catch(subscribe);
  if (!response.ok || response.body === null) throw new Error("could not subscribe to /events");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const nextFrame = async (event: string) => {
    while (true) {
      const separator = buffered.indexOf("\n\n");
      if (separator !== -1) {
        const frame = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        if (frame.includes(`event: ${event}`)) return;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended mid-benchmark");
      buffered += decoder.decode(value, { stream: true });
    }
  };
  return { nextFrame, stop: () => controller.abort() };
}

/**
 * The household case: every device in the house is watching when an agent
 * moves. One update is posted; the sample's latency is when the SLOWEST of
 * `devices` subscribers received its patch, because the deck is only as live
 * as its worst screen.
 */
async function sseFanout(devices: number, samples: number): Promise<Stats> {
  const subscribers = await Promise.all(Array.from({ length: devices }, subscriber));
  await Promise.all(subscribers.map((device) => device.nextFrame("snapshot")));
  const latencies: number[] = [];
  const started = performance.now();
  for (let sample = 0; sample < samples; sample++) {
    const begin = performance.now();
    await drained(heartbeat(sample, `fanout round ${sample}`));
    await Promise.all(subscribers.map((device) => device.nextFrame("patch")));
    latencies.push(performance.now() - begin);
  }
  const wall = (performance.now() - started) / 1000;
  for (const device of subscribers) device.stop();
  latencies.sort((a, b) => a - b);
  return {
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    p99: quantile(latencies, 0.99),
    max: latencies[latencies.length - 1] ?? 0,
    perSecond: samples / wall,
  };
}

const row = (name: string, stats: Stats) =>
  [
    name.padEnd(18),
    `${stats.perSecond.toFixed(0).padStart(6)}/s`,
    `p50 ${stats.p50.toFixed(1).padStart(6)}ms`,
    `p95 ${stats.p95.toFixed(1).padStart(6)}ms`,
    `p99 ${stats.p99.toFixed(1).padStart(6)}ms`,
    `max ${stats.max.toFixed(1).padStart(6)}ms`,
  ].join("  ");

await waitForBridge();

// Seed the deck so reads and pushes pay for a realistically full snapshot.
for (let index = 0; index < AGENTS; index++) await drained(heartbeat(index, "seeding"));

console.log(`bridge bench — ${AGENTS} agents seeded, Bun ${Bun.version}`);
console.log(
  row(
    "heartbeat ingest",
    await measure(EVENTS_PER_KIND, 16, (index) => heartbeat(index, `load ${index}`)),
  ),
);
console.log(
  row(
    "event ingest",
    await measure(EVENTS_PER_KIND, 16, (index) =>
      fetch(`${BASE}/agents/bench-agent-${index % AGENTS}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "tool",
          summary: `Ran a tool (${index})`,
          detail: "bench detail ".repeat(20),
        }),
      }),
    ),
  ),
);
console.log(row("snapshot read", await measure(200, 8, () => fetch(`${BASE}/snapshot`))));
console.log(row("SSE push", await sseLatency(SSE_SAMPLES)));
console.log(row("SSE fanout ×20", await sseFanout(20, SSE_SAMPLES)));

process.exit(0);
