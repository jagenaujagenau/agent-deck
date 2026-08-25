"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentsStore, useTasksStore } from "@/store";
import { AgentsSidebar } from "./sidebar/agents-sidebar";
import { KanbanBoard } from "./kanban/board";
import { ChatWindowManager } from "./chat/chat-window-manager";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { NewAgentDialog } from "./sidebar/new-agent-dialog";
import { NewTaskDialog } from "./kanban/new-task-dialog";

export function DashboardLayout() {
  const fetchAgents = useAgentsStore((state) => state.fetchAgents);
  const fetchTasks = useTasksStore((state) => state.fetchTasks);
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const [showNewTaskDialog, setShowNewTaskDialog] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchAgents();
    fetchTasks();
  }, [fetchAgents, fetchTasks]);

  useKeyboardShortcuts([
    {
      key: "n",
      handler: () => {
        (window as any).__kanbanNewTask?.();
      },
    },
    {
      key: "a",
      handler: () => setShowNewAgentDialog(true),
    },
    {
      key: "/",
      handler: () => {
        searchInputRef.current?.focus();
      },
    },
  ]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <AgentsSidebar searchInputRef={searchInputRef as React.RefObject<HTMLInputElement>} />
      <main className="flex-1 overflow-auto">
        <KanbanBoard />
      </main>
      <ChatWindowManager />
      <NewAgentDialog open={showNewAgentDialog} onOpenChange={setShowNewAgentDialog} />
    </div>
  );
}
