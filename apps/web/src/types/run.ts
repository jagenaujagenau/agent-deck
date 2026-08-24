export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  agentId: string;
  taskId?: string;
  status: RunStatus;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  tokensUsed?: number;
  duration?: number; // milliseconds
}

export interface CreateRunInput {
  agentId: string;
  taskId?: string;
}
