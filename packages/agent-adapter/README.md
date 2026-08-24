# Agent Deck Runtime Adapter SDK

Shared TypeScript client for connecting agent runtimes to the Agent Deck bridge.

```ts
import { AgentDeckClient } from "@agent-control-dashboard/agent-adapter";

const deck = new AgentDeckClient();
await deck.heartbeat({
  id: sessionId,
  name: "My runtime",
  project: "project-name",
  model: "model-name",
  state: "running",
  task: "Implementing feature",
  capabilities: ["approve", "reject"],
});
await deck.event(sessionId, { kind: "tool", summary: "Running tests" });
```

`AgentDeckClient` provides authenticated heartbeats, stable event upserts, command polling, acknowledgements, and blocking approval decisions. It reads `AGENT_DECK_URL`, `AGENT_DECK_TOKEN`, or the `0600` runtime token at `~/.config/agent-deck/runtime-token`.

Adapters must publish only controls they can genuinely execute via `capabilities`; the server rejects unsupported actions.
