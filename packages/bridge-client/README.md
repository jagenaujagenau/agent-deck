# @agent-control-dashboard/bridge-client

The consumer SDK for the Agent Deck bridge. The bridge unifies every coding
agent's activity into one canonical stream; this package is the half a new
interface needs — the live stream, the shared policies, and the verbs — so a
client can be built without rediscovering the wire contract
([`docs/bridge-api.md`](../../docs/bridge-api.md)) from three apps' source.

Zero dependencies. Runs anywhere `fetch` and `ReadableStream` do: Bun, Node
18+, browsers.

```ts
import {
  BridgeClient,
  subscribeDeck,
  attentionPriority,
  sessionSeen,
  mergeSessionEvents,
  conversationEntries,
  AgentBlockedError,
} from "@agent-control-dashboard/bridge-client";

const client = new BridgeClient("http://bridge-host:3000");
await client.pair("482913", "My new surface"); // stores the minted token

// The live deck: a full snapshot after every change, patches applied for you.
const subscription = subscribeDeck("http://bridge-host:3000", token, {
  onSnapshot(deck) {
    const ranked = [...deck.agents].sort(
      (a, b) =>
        attentionPriority(b.state, b.pendingApproval !== undefined, sessionSeen(b)) -
        attentionPriority(a.state, a.pendingApproval !== undefined, sessionSeen(a)),
    );
    render(ranked);
  },
});

// A session view: retained history merged under the live window,
// then shaped into the chat.
const history = await client.history(agentId, 300);
const events = mergeSessionEvents(history, agent.events);
const chat = conversationEntries(events);

// Acting. A prompt to a blocked session throws the bridge's own sentence;
// force only after the person chose to queue anyway.
try {
  await client.control(agentId, "prompt", "run the tests");
} catch (error) {
  if (error instanceof AgentBlockedError) offerSendAnyway(error.message);
}
```

What's here, and why it is here rather than in your app:

- **`subscribeDeck`** — the SSE stream with the snapshot/patch protocol
  applied correctly (per-connection frames, reconnect with backoff, pings
  consumed).
- **`mergeSessionEvents`** — history under live, restoring the `command`,
  `diff`, and full `detail` the snapshot deliberately strips.
- **`conversationEntries` / `reasoningEvents` / `terminalEvents`** — one
  definition of the tabs; a conversation assembled twice is two conversations.
- **`attentionPriority` / `sessionSeen`** — the shared attention model:
  error > blocked > done-unseen > running > idle-seen, and seen merged from
  the local mark and the bridge's `viewedAt`. Only an explicit human view may
  mark seen.
- **`BridgeClient`** — the verbs, with `agent_blocked` surfaced as a typed
  refusal instead of a status code to grep for.

The Android, Wear OS, and iOS apps in this repository keep their own ports of
these policies (Kotlin and Swift); this package is the reference expression,
and the one contract tests run against.
