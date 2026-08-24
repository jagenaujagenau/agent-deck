"use client";

import type { Task } from "@/types/task";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTasksStore } from "@/store";
import { useAgentsStore } from "@/store";
import { useState } from "react";
import { TaskDetailSheet } from "./task-detail-sheet";
import { cn } from "@/lib/utils";
import { useDraggable } from "@dnd-kit/core";

interface TaskCardProps {
  task: Task;
}

const priorityColors = {
  low: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  medium: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  high: "bg-red-500/10 text-red-700 dark:text-red-400",
};

export function TaskCard({ task }: TaskCardProps) {
  const agents = useAgentsStore((state) => state.agents);
  const [showDetailSheet, setShowDetailSheet] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: task.id,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;

  const assignedAgent = task.assignedAgentId
    ? agents.find((a) => a.id === task.assignedAgentId)
    : null;

  return (
    <>
      <Card
        ref={setNodeRef}
        style={style}
        {...listeners}
        {...attributes}
        className={cn(
          "p-4 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow",
          isDragging && "opacity-50"
        )}
        onClick={() => setShowDetailSheet(true)}
      >
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium text-sm line-clamp-2">{task.title}</h3>
            <Badge
              className={cn(
                "text-xs shrink-0",
                priorityColors[task.priority]
              )}
            >
              {task.priority}
            </Badge>
          </div>

          {task.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {task.description}
            </p>
          )}

          {assignedAgent && (
            <div className="flex items-center gap-2 mt-2">
              <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">
                {assignedAgent.name.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs text-muted-foreground">
                {assignedAgent.name}
              </span>
            </div>
          )}
        </div>
      </Card>

      <TaskDetailSheet
        task={task}
        open={showDetailSheet}
        onOpenChange={setShowDetailSheet}
      />
    </>
  );
}
