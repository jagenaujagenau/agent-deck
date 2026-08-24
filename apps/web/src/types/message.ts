export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: string;
  agentId: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
  runId?: string;
}

export interface CreateMessageInput {
  agentId: string;
  content: string;
  role: MessageRole;
  runId?: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}
