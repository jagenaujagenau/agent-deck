"use client";

import { useWindowsStore, useAgentsStore } from "@/store";
import { ChatWindow } from "./chat-window";

export function ChatWindowManager() {
  const windows = useWindowsStore((state) => state.windows);
  const agents = useAgentsStore((state) => state.agents);

  const openWindows = Object.keys(windows).map((agentId) => {
    const agent = agents.find((a) => a.id === agentId);
    return agent ? { agent, window: windows[agentId] } : null;
  }).filter((w): w is { agent: typeof agents[0]; window: typeof windows[string] } => w !== null);

  if (openWindows.length === 0) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-50">
      {openWindows.map(({ agent }) => (
        <ChatWindow key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
