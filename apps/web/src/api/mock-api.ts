import { Effect } from "effect";
import { nanoid } from "nanoid";
import { mockDb } from "./mock-db";
import {
  AgentNotFoundError,
  TaskNotFoundError,
  ApiFailureError,
  maybeFail,
  simulateDelay,
} from "./chaos";
import { createMockStream, generateMockResponse } from "./stream-simulator";
import type { Agent, CreateAgentInput, UpdateAgentInput, AgentProfileStats } from "@/types/agent";
import type { Task, CreateTaskInput, UpdateTaskInput } from "@/types/task";
import type { Run, CreateRunInput } from "@/types/run";
import type { Message, StreamChunk } from "@/types/message";

// Settings for chaos mode (will be read from settings store)
let chaosEnabled = false;
let taskUpdateFailureRate = 0.1;
let agentActionFailureRate = 0.05;

export const setChaosSettings = (enabled: boolean, taskRate: number, agentRate: number) => {
  chaosEnabled = enabled;
  taskUpdateFailureRate = taskRate;
  agentActionFailureRate = agentRate;
};

// Agent API
export const agents = {
  list: (): Effect.Effect<Agent[], never, never> => Effect.sync(() => mockDb.getAgents()),

  get: (id: string): Effect.Effect<Agent, AgentNotFoundError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      const agent = mockDb.getAgent(id);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(id));
      }
      return agent;
    }),

  create: (input: CreateAgentInput): Effect.Effect<Agent, ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(200 + Math.random() * 200);
      yield* maybeFail(agentActionFailureRate, "Failed to create agent");
      return mockDb.createAgent(input);
    }),

  update: (
    id: string,
    input: UpdateAgentInput,
  ): Effect.Effect<Agent, AgentNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(150 + Math.random() * 100);
      yield* maybeFail(agentActionFailureRate, "Failed to update agent");
      const agent = mockDb.getAgent(id);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(id));
      }
      return mockDb.updateAgent(id, input) as Agent;
    }),

  delete: (id: string): Effect.Effect<void, AgentNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      yield* maybeFail(agentActionFailureRate, "Failed to delete agent");
      const agent = mockDb.getAgent(id);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(id));
      }
      mockDb.deleteAgent(id);
    }),

  run: (
    agentId: string,
    taskId?: string,
  ): Effect.Effect<Run, AgentNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(200 + Math.random() * 200);
      yield* maybeFail(agentActionFailureRate, "Failed to run agent");
      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }
      const run = mockDb.createRun({ agentId, taskId });
      mockDb.updateAgent(agentId, {
        status: "running",
        lastRunAt: new Date(),
      });
      return run;
    }),

  stop: (agentId: string): Effect.Effect<void, AgentNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(150 + Math.random() * 100);
      yield* maybeFail(agentActionFailureRate, "Failed to stop agent");
      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }
      mockDb.updateAgent(agentId, { status: "stopped" });
    }),

  pause: (agentId: string): Effect.Effect<void, AgentNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      yield* maybeFail(agentActionFailureRate, "Failed to pause agent");
      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }
      if (agent.status === "running") {
        mockDb.updateAgent(agentId, { status: "paused" });
      }
    }),

  resume: (agentId: string): Effect.Effect<void, AgentNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      yield* maybeFail(agentActionFailureRate, "Failed to resume agent");
      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }
      if (agent.status === "paused") {
        mockDb.updateAgent(agentId, { status: "running" });
      }
    }),

  profileStats: (agentId: string): Effect.Effect<AgentProfileStats, AgentNotFoundError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(150 + Math.random() * 100);
      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }

      const runs = mockDb.getRuns(agentId);
      const completedRuns = runs.filter((r) => r.status === "completed");
      const failedRuns = runs.filter((r) => r.status === "failed");
      const totalTokens = completedRuns.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
      const totalDuration = completedRuns.reduce((sum, r) => sum + (r.duration || 0), 0);
      const avgResponseTime = completedRuns.length > 0 ? totalDuration / completedRuns.length : 0;

      const tasks = mockDb.getTasks();
      const tasksCompleted = tasks.filter(
        (t) => t.assignedAgentId === agentId && t.stage === "done",
      ).length;

      return {
        agentId,
        totalRuns: runs.length,
        successfulRuns: completedRuns.length,
        failedRuns: failedRuns.length,
        totalTokensUsed: totalTokens,
        averageResponseTime: avgResponseTime,
        lastRunAt: runs.length > 0 ? runs[runs.length - 1].startedAt : undefined,
        tasksCompleted,
      };
    }),
};

// Task API
export const tasks = {
  list: (): Effect.Effect<Task[], never, never> => Effect.sync(() => mockDb.getTasks()),

  get: (id: string): Effect.Effect<Task, TaskNotFoundError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      const task = mockDb.getTask(id);
      if (!task) {
        return yield* Effect.fail(new TaskNotFoundError(id));
      }
      return task;
    }),

  create: (input: CreateTaskInput): Effect.Effect<Task, ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(200 + Math.random() * 200);
      yield* maybeFail(taskUpdateFailureRate, "Failed to create task");
      return mockDb.createTask(input);
    }),

  update: (
    id: string,
    input: UpdateTaskInput,
  ): Effect.Effect<Task, TaskNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(150 + Math.random() * 100);
      yield* maybeFail(taskUpdateFailureRate, "Failed to update task");
      const task = mockDb.getTask(id);
      if (!task) {
        return yield* Effect.fail(new TaskNotFoundError(id));
      }
      return mockDb.updateTask(id, input) as Task;
    }),

  delete: (id: string): Effect.Effect<void, TaskNotFoundError | ApiFailureError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      yield* maybeFail(taskUpdateFailureRate, "Failed to delete task");
      const task = mockDb.getTask(id);
      if (!task) {
        return yield* Effect.fail(new TaskNotFoundError(id));
      }
      mockDb.deleteTask(id);
    }),
};

// Chat API
export const chat = {
  getMessages: (agentId: string): Effect.Effect<Message[], AgentNotFoundError, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }
      return mockDb.getMessages(agentId);
    }),

  sendMessage: (
    agentId: string,
    content: string,
  ): Effect.Effect<
    { messageId: string; stream: ReadableStream<StreamChunk> },
    AgentNotFoundError | ApiFailureError,
    never
  > =>
    Effect.gen(function* () {
      yield* simulateDelay(200 + Math.random() * 200);
      yield* maybeFail(0.05, "Failed to send message");

      const agent = mockDb.getAgent(agentId);
      if (!agent) {
        return yield* Effect.fail(new AgentNotFoundError(agentId));
      }

      // Create user message
      const userMessage = mockDb.createMessage({
        agentId,
        content,
        role: "user",
      });

      // Generate mock response
      const responseText = generateMockResponse(content);

      // Create stream
      const streamResult = yield* createMockStream(responseText);
      const stream = streamResult as ReadableStream<StreamChunk>;

      // Store assistant message as it streams (will be updated by the stream handler)
      const assistantMessageId = nanoid();
      mockDb.createMessage({
        agentId,
        content: "", // Will be updated as stream progresses
        role: "assistant",
      });

      return {
        messageId: assistantMessageId,
        stream,
      };
    }),
};

// Metrics API
export const metrics = {
  summary: (): Effect.Effect<
    {
      tokensSpent: number;
      tasksCompleted: number;
      errorRate: number;
      lastRun?: Run;
    },
    never,
    never
  > =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      return mockDb.getMetrics();
    }),
};

// Runs API
export const runs = {
  list: (agentId?: string, taskId?: string): Effect.Effect<Run[], never, never> =>
    Effect.sync(() => mockDb.getRuns(agentId, taskId)),

  get: (id: string): Effect.Effect<Run, never, never> =>
    Effect.gen(function* () {
      yield* simulateDelay(100 + Math.random() * 100);
      const run = mockDb.getRun(id);
      if (!run) {
        throw new Error(`Run ${id} not found`);
      }
      return run;
    }),
};
