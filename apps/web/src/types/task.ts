export type TaskStage =
  | 'backlog'
  | 'next'
  | 'in_progress'
  | 'review'
  | 'ready_to_ship'
  | 'done';

export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string;
  stage: TaskStage;
  assignedAgentId?: string;
  priority: TaskPriority;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  priority?: TaskPriority;
  stage?: TaskStage;
  assignedAgentId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  stage?: TaskStage;
  assignedAgentId?: string;
  priority?: TaskPriority;
}

export const TASK_STAGES: TaskStage[] = [
  'backlog',
  'next',
  'in_progress',
  'review',
  'ready_to_ship',
  'done',
];

export const TASK_STAGE_LABELS: Record<TaskStage, string> = {
  backlog: 'Backlog',
  next: 'Next',
  in_progress: 'In Progress',
  review: 'Ready to Review',
  ready_to_ship: 'Ready to Ship',
  done: 'Done',
};
