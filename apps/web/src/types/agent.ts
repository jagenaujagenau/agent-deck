export type AgentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  model: string;
  config: Record<string, unknown>;
  createdAt: Date;
  lastRunAt?: Date;
}

export interface CreateAgentInput {
  name: string;
  description: string;
  model: string;
  config?: Record<string, unknown>;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  model?: string;
  config?: Record<string, unknown>;
}

export interface AgentProfileStats {
  agentId: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalTokensUsed: number;
  averageResponseTime: number;
  lastRunAt?: Date;
  tasksCompleted: number;
}
