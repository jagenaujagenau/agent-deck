"use client";

import type { Task, TaskStage } from "@/types/task";
import { TaskCard } from "./task-card";
import { cn } from "@/lib/utils";
import { useDroppable } from "@dnd-kit/core";

interface KanbanColumnProps {
  stage: TaskStage;
  label: string;
  tasks: Task[];
}

export function KanbanColumn({ stage, label, tasks }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: stage,
  });

  return (
    <div className="flex flex-col w-80 flex-shrink-0">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-muted-foreground">{label}</h2>
        <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">
          {tasks.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex-1 space-y-2 overflow-y-auto pb-4 rounded-lg transition-colors",
          "min-h-[200px]",
          isOver && "bg-accent/50",
        )}
      >
        {tasks.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground border-2 border-dashed rounded-lg">
            No tasks
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </div>
  );
}
