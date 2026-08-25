"use client";

import type { Agent } from "@/types/agent";
import { StatusBadge } from "@/components/ui/status-badge";
import { AgentContextMenu } from "./agent-context-menu";
import { useWindowsStore } from "@/store";
import { cn } from "@/lib/utils";

interface AgentItemProps {
  agent: Agent;
}

export function AgentItem({ agent }: AgentItemProps) {
  const openWindow = useWindowsStore((state) => state.openWindow);

  const handleClick = () => {
    openWindow(agent.id);
  };

  return (
    <AgentContextMenu agent={agent}>
      <div
        onClick={handleClick}
        className={cn(
          "group relative flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-colors",
          "hover:bg-sidebar-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        )}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="text-sm font-medium truncate">{agent.name}</h3>
            <StatusBadge status={agent.status} />
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
        </div>
      </div>
    </AgentContextMenu>
  );
}
