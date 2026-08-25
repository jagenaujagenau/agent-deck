"use client";

import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Agent } from "@/types/agent";
import { useAgentsStore } from "@/store";
import { useWindowsStore } from "@/store";
import { EditIcon, PlayIcon, SquareIcon, PauseIcon, PlayCircleIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { EditAgentConfigDialog } from "../modals/edit-agent-config";
import { AgentProfileModal } from "../modals/agent-profile";

interface AgentContextMenuProps {
  agent: Agent;
  children: ReactNode;
}

export function AgentContextMenu({ agent, children }: AgentContextMenuProps) {
  const runAgent = useAgentsStore((state) => state.runAgent);
  const stopAgent = useAgentsStore((state) => state.stopAgent);
  const pauseAgent = useAgentsStore((state) => state.pauseAgent);
  const resumeAgent = useAgentsStore((state) => state.resumeAgent);
  const openWindow = useWindowsStore((state) => state.openWindow);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const handleRun = () => {
    runAgent(agent.id);
  };

  const handleStop = () => {
    stopAgent(agent.id);
  };

  const handlePause = () => {
    pauseAgent(agent.id);
  };

  const handleResume = () => {
    resumeAgent(agent.id);
  };

  const handleEditConfig = () => {
    setShowEditDialog(true);
  };

  const handleViewProfile = () => {
    setShowProfileModal(true);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleEditConfig}>
            <EditIcon className="mr-2 h-4 w-4" />
            Edit Config
          </ContextMenuItem>
          <ContextMenuSeparator />
          {agent.status === "idle" || agent.status === "stopped" ? (
            <ContextMenuItem onClick={handleRun}>
              <PlayIcon className="mr-2 h-4 w-4" />
              Run
            </ContextMenuItem>
          ) : null}
          {agent.status === "running" ? (
            <>
              <ContextMenuItem onClick={handleStop}>
                <SquareIcon className="mr-2 h-4 w-4" />
                Stop
              </ContextMenuItem>
              <ContextMenuItem onClick={handlePause}>
                <PauseIcon className="mr-2 h-4 w-4" />
                Pause
              </ContextMenuItem>
            </>
          ) : null}
          {agent.status === "paused" ? (
            <ContextMenuItem onClick={handleResume}>
              <PlayCircleIcon className="mr-2 h-4 w-4" />
              Resume
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleViewProfile}>
            <UserIcon className="mr-2 h-4 w-4" />
            View Profile
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <EditAgentConfigDialog agent={agent} open={showEditDialog} onOpenChange={setShowEditDialog} />
      <AgentProfileModal
        agentId={agent.id}
        open={showProfileModal}
        onOpenChange={setShowProfileModal}
      />
    </>
  );
}
