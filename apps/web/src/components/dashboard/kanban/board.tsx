"use client";

import { useTasksStore } from "@/store";
import { KanbanColumn } from "./column";
import { TASK_STAGES, TASK_STAGE_LABELS } from "@/types/task";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useState, useEffect } from "react";
import { NewTaskDialog } from "./new-task-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { DndContext, DragOverlay, closestCorners, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import type { TaskStage } from "@/types/task";

interface KanbanBoardProps {
  onNewTask?: () => void;
}

export function KanbanBoard({ onNewTask }: KanbanBoardProps = {}) {
  const tasks = useTasksStore((state) => state.tasks);
  const loading = useTasksStore((state) => state.loading);
  const moveTask = useTasksStore((state) => state.moveTask);
  const [showNewTaskDialog, setShowNewTaskDialog] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  // Expose setShowNewTaskDialog to parent via global for keyboard shortcut
  useEffect(() => {
    (window as any).__kanbanNewTask = () => setShowNewTaskDialog(true);
    return () => {
      delete (window as any).__kanbanNewTask;
    };
  }, []);

  if (loading && tasks.length === 0) {
    return (
      <div className="p-6">
        <div className="flex gap-4">
          {TASK_STAGES.map((stage) => (
            <div key={stage} className="flex-1">
              <Skeleton className="h-8 w-24 mb-4" />
              <div className="space-y-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTaskId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTaskId(null);
    const { active, over } = event;

    if (!over) return;

    const taskId = active.id as string;
    const newStage = over.id as TaskStage;

    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.stage === newStage) return;

    const success = await moveTask(taskId, newStage);
    if (!success) {
      toast.error("Failed to move task", {
        action: {
          label: "Undo",
          onClick: () => moveTask(taskId, task.stage),
        },
      });
    }
  };

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-6 border-b">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <Button onClick={() => setShowNewTaskDialog(true)}>
          <PlusIcon className="mr-2 h-4 w-4" />
          New Task
        </Button>
      </div>

      <DndContext
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 overflow-x-auto p-6">
          <div className="flex gap-4 h-full min-w-max">
            {TASK_STAGES.map((stage) => {
              const stageTasks = tasks.filter((task) => task.stage === stage);
              return (
                <KanbanColumn
                  key={stage}
                  stage={stage}
                  label={TASK_STAGE_LABELS[stage]}
                  tasks={stageTasks}
                />
              );
            })}
          </div>
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="p-4 bg-card border rounded-lg shadow-lg w-80">
              <h3 className="font-medium text-sm">{activeTask.title}</h3>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <NewTaskDialog
        open={showNewTaskDialog}
        onOpenChange={setShowNewTaskDialog}
      />
    </div>
  );
}
