#!/usr/bin/env bun
import { AgentDeckClient } from "../packages/agent-adapter/src/client";

/**
 * A believable deck, invented from nothing.
 *
 * For showing the product without showing somebody's actual work: real session
 * names, real reasoning and real diffs are all somebody's private repository.
 * This talks to a bridge of its own on another port, so nothing it writes can
 * reach the deck anyone is really using.
 *
 * It keeps running rather than seeding and exiting. Sessions go offline without
 * heartbeats, and a deck of dead sessions demonstrates nothing - so this holds
 * them alive and moves them along while it runs.
 */

const client = new AgentDeckClient({
  baseUrl: process.env.DEMO_BRIDGE_URL ?? "http://127.0.0.1:3100",
  token: "",
});

interface Character {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly model: string;
  readonly runtime: string;
  state: string;
  task: string;
  readonly tokens: number;
  readonly costUsd: number;
  readonly capabilities: ReadonlyArray<string>;
}

/**
 * The cast, chosen to show the deck's range in one screen: something wanting
 * approval, something asking a question, something working, something resting.
 */
const cast: Character[] = [
  {
    id: "claude-demo-orbital",
    name: "Claude · orbital-api · 4f2a",
    project: "orbital-api",
    model: "Claude Code",
    runtime: "claude",
    state: "waiting",
    task: "Approval: Bash · rm -rf .cache/build",
    tokens: 184_320,
    costUsd: 3.42,
    capabilities: ["approve", "reject", "steer", "prompt", "stop", "pause"],
  },
  {
    id: "claude-demo-checkout",
    name: "Claude · checkout-flow · b91c",
    project: "checkout-flow",
    model: "Claude Code",
    runtime: "claude",
    state: "waiting",
    task: "Which payment provider should the retry path use?",
    tokens: 96_140,
    costUsd: 1.87,
    capabilities: ["approve", "reject", "steer", "prompt", "stop"],
  },
  {
    id: "claude-demo-atlas",
    name: "Claude · atlas-docs · 7d30",
    project: "atlas-docs",
    model: "Claude Code",
    runtime: "claude",
    state: "running",
    task: "Using Edit",
    tokens: 51_002,
    costUsd: 0.94,
    capabilities: ["steer", "prompt", "stop", "pause"],
  },
  {
    id: "opencode-demo-hex",
    name: "OpenCode · hex-renderer · 2ee8",
    project: "hex-renderer",
    model: "opencode/deepseek-v4-pro",
    runtime: "opencode",
    state: "running",
    task: "Read completed",
    tokens: 33_470,
    costUsd: 0.41,
    capabilities: ["approve", "reject"],
  },
  {
    id: "codex-demo-vine",
    name: "Codex · vine-cli · a55b",
    project: "vine-cli",
    model: "Codex",
    runtime: "codex",
    state: "idle",
    task: "Ready for an instruction",
    tokens: 12_880,
    costUsd: 0.22,
    capabilities: ["steer", "prompt", "stop"],
  },
  {
    id: "demo-pi-lantern",
    name: "Pi · lantern · c018",
    project: "lantern",
    model: "anthropic/opus",
    runtime: "pi",
    state: "idle",
    task: "Ready for a remote instruction",
    tokens: 7_410,
    costUsd: 0.13,
    capabilities: ["approve", "reject", "steer", "prompt", "follow_up"],
  },
];

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

/** The conversation each session is partway through. */
const script: Record<
  string,
  ReadonlyArray<{ kind: string; summary: string; detail?: string; ago: number; options?: string[] }>
> = {
  "claude-demo-orbital": [
    {
      kind: "user",
      summary: "Message",
      detail: "The build cache is stale again — can you clear it and rerun?",
      ago: 240,
    },
    {
      kind: "thought",
      summary: "Reasoning",
      detail:
        "The cache directory is generated, so removing it is safe. It sits inside the repo, though, so I should ask before deleting recursively rather than assume.",
      ago: 200,
    },
    {
      kind: "output",
      summary: "Response",
      detail:
        "I can clear it. That's a recursive delete inside the repo, so I'd rather you approve it.",
      ago: 180,
    },
  ],
  "claude-demo-checkout": [
    { kind: "user", summary: "Message", detail: "Add a retry path for failed payments.", ago: 420 },
    {
      kind: "thought",
      summary: "Reasoning",
      detail:
        "There are two providers wired up here and the retry semantics differ: one is idempotent by key, the other charges again on replay. Guessing wrong means double charges.",
      ago: 380,
    },
    {
      kind: "question",
      summary: "Which payment provider should the retry path use?",
      detail: "Stripe retries are idempotent by key; the legacy provider is not.",
      ago: 360,
      options: ["Stripe only", "Both, with a guard", "Ask me per payment"],
    },
  ],
  "claude-demo-atlas": [
    {
      kind: "user",
      summary: "Message",
      detail: "Rewrite the getting-started page for someone who has never used it.",
      ago: 150,
    },
    {
      kind: "thought",
      summary: "Reasoning",
      detail:
        "The current page opens with configuration, which assumes the reader already decided to use this. Better to open with what it does in one sentence, then the smallest thing that works.",
      ago: 90,
    },
    { kind: "tool", summary: "Using Edit", detail: "docs/getting-started.md", ago: 20 },
  ],
  "opencode-demo-hex": [
    {
      kind: "user",
      summary: "Message",
      detail: "Why is the tile renderer dropping frames on wide maps?",
      ago: 300,
    },
    {
      kind: "thought",
      summary: "Reasoning",
      detail:
        "Every tile allocates its own paint object per frame. At 4,000 tiles that is 4,000 allocations sixty times a second, which is the garbage collector, not the renderer.",
      ago: 120,
    },
    {
      kind: "output",
      summary: "Response",
      detail:
        "It's allocation, not draw calls — each tile builds a new paint every frame. Hoisting it out is a one-line change.",
      ago: 60,
    },
  ],
  "codex-demo-vine": [
    { kind: "user", summary: "Message", detail: "Ship the changelog for 2.4.", ago: 900 },
    {
      kind: "output",
      summary: "Response",
      detail: "Written and tagged. 2.4 covers the parser rewrite and two fixes to `vine watch`.",
      ago: 840,
    },
  ],
  "demo-pi-lantern": [
    { kind: "user", summary: "Message", detail: "Any tests failing on main?", ago: 1200 },
    {
      kind: "output",
      summary: "Response",
      detail: "None. 214 pass, and the flaky socket test has held for twenty runs.",
      ago: 1160,
    },
  ],
};

async function heartbeat(character: Character) {
  await client
    .heartbeat({
      id: character.id,
      name: character.name,
      project: character.project,
      model: character.model,
      runtime: character.runtime,
      state: character.state as never,
      task: character.task,
      tokens: character.tokens,
      processedTokens: character.tokens * 42,
      costUsd: character.costUsd,
      capabilities: character.capabilities as never,
      ...(character.id === "claude-demo-orbital"
        ? {
            pendingApproval: {
              id: "demo-approval-1",
              tool: "Bash",
              detail: "rm -rf .cache/build",
              createdAt: at(180),
              // Far enough out that it is still pending whenever this is shown.
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            },
          }
        : {}),
    })
    .catch(() => {});
}

async function seed() {
  for (const character of cast) {
    await heartbeat(character);
    for (const [index, line] of (script[character.id] ?? []).entries()) {
      await client
        .event(character.id, {
          id: `${character.id}:${index}`,
          kind: line.kind as never,
          summary: line.summary,
          detail: line.detail,
          ...(line.options ? { options: line.options } : {}),
        })
        .catch(() => {});
    }
  }
  console.log(`Seeded ${cast.length} sessions on ${client.baseUrl}`);
}

/** Small movements, so a recording shows a deck that is alive rather than a screenshot. */
const beats = [
  {
    id: "claude-demo-atlas",
    task: "Using Edit",
    kind: "tool",
    summary: "Using Edit",
    detail: "docs/getting-started.md",
  },
  {
    id: "claude-demo-atlas",
    task: "Edit completed",
    kind: "output",
    summary: "Edit completed",
    detail: "docs/getting-started.md · +18 −6",
  },
  {
    id: "opencode-demo-hex",
    task: "Using Grep",
    kind: "tool",
    summary: "Using Grep",
    detail: "paint(",
  },
  {
    id: "claude-demo-atlas",
    task: "Using Read",
    kind: "tool",
    summary: "Using Read",
    detail: "docs/index.md",
  },
  {
    id: "opencode-demo-hex",
    task: "Grep completed",
    kind: "output",
    summary: "Grep completed",
    detail: "12 matches in 3 files",
  },
];

async function main() {
  await seed();
  let beat = 0;
  for (;;) {
    await Bun.sleep(4_000);
    for (const character of cast) await heartbeat(character);
    const step = beats[beat % beats.length]!;
    const character = cast.find((entry) => entry.id === step.id);
    if (character) {
      character.task = step.task;
      await client
        .event(character.id, {
          id: `${character.id}:beat:${beat}`,
          kind: step.kind as never,
          summary: step.summary,
          detail: step.detail,
        })
        .catch(() => {});
    }
    beat += 1;
  }
}

void main();
