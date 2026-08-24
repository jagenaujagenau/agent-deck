/**
 * Mock unRPC client interface
 * This mimics what a real unRPC client would look like
 * All methods return Effect types for easy integration
 */
import * as api from './mock-api';

export const mockClient = {
  agents: api.agents,
  tasks: api.tasks,
  chat: api.chat,
  metrics: api.metrics,
  runs: api.runs,
};

export type MockClient = typeof mockClient;
