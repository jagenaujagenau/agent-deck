import { nanoid } from "nanoid";
import type { Agent, CreateAgentInput } from "@/types/agent";
import type { Task, CreateTaskInput } from "@/types/task";
import type { Run, CreateRunInput } from "@/types/run";
import type { Message, CreateMessageInput } from "@/types/message";

class MockDatabase {
  private agents: Map<string, Agent> = new Map();
  private tasks: Map<string, Task> = new Map();
  private runs: Map<string, Run> = new Map();
  private messages: Map<string, Message> = new Map();
  private agentMessages: Map<string, string[]> = new Map(); // agentId -> messageIds[]

  constructor() {
    this.seed();
  }

  private seed() {
    // Seed some initial agents
    const agent1: Agent = {
      id: nanoid(),
      name: "Code Reviewer",
      description: "Reviews code and suggests improvements",
      status: "idle",
      model: "gpt-4",
      config: { temperature: 0.7 },
      createdAt: new Date(Date.now() - 86400000),
    };

    const agent2: Agent = {
      id: nanoid(),
      name: "Bug Fixer",
      description: "Fixes bugs and writes tests",
      status: "idle",
      model: "claude-3",
      config: { temperature: 0.5 },
      createdAt: new Date(Date.now() - 172800000),
    };

    const agent3: Agent = {
      id: nanoid(),
      name: "Feature Builder",
      description: "Builds new features from specifications",
      status: "running",
      model: "gpt-4",
      config: { temperature: 0.8 },
      createdAt: new Date(Date.now() - 259200000),
      lastRunAt: new Date(Date.now() - 3600000),
    };

    this.agents.set(agent1.id, agent1);
    this.agents.set(agent2.id, agent2);
    this.agents.set(agent3.id, agent3);

    // Seed some initial tasks
    const now = new Date();
    const task1: Task = {
      id: nanoid(),
      title: "Add user authentication",
      description: "Implement OAuth2 authentication flow",
      stage: "backlog",
      priority: "high",
      createdAt: new Date(now.getTime() - 86400000),
      updatedAt: new Date(now.getTime() - 86400000),
    };

    const task2: Task = {
      id: nanoid(),
      title: "Fix memory leak in dashboard",
      description: "Investigate and fix memory leak in React components",
      stage: "next",
      priority: "high",
      createdAt: new Date(now.getTime() - 43200000),
      updatedAt: new Date(now.getTime() - 43200000),
    };

    const task3: Task = {
      id: nanoid(),
      title: "Implement dark mode",
      description: "Add dark mode toggle and theme switching",
      stage: "in_progress",
      priority: "medium",
      assignedAgentId: agent3.id,
      createdAt: new Date(now.getTime() - 21600000),
      updatedAt: new Date(now.getTime() - 3600000),
    };

    const task4: Task = {
      id: nanoid(),
      title: "Optimize database queries",
      description: "Add indexes and optimize slow queries",
      stage: "review",
      priority: "medium",
      assignedAgentId: agent1.id,
      createdAt: new Date(now.getTime() - 172800000),
      updatedAt: new Date(now.getTime() - 7200000),
    };

    const task5: Task = {
      id: nanoid(),
      title: "Update documentation",
      description: "Update API documentation with latest changes",
      stage: "ready_to_ship",
      priority: "low",
      createdAt: new Date(now.getTime() - 259200000),
      updatedAt: new Date(now.getTime() - 1800000),
    };

    this.tasks.set(task1.id, task1);
    this.tasks.set(task2.id, task2);
    this.tasks.set(task3.id, task3);
    this.tasks.set(task4.id, task4);
    this.tasks.set(task5.id, task5);
  }

  // Agent methods
  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  createAgent(input: CreateAgentInput): Agent {
    const agent: Agent = {
      id: nanoid(),
      ...input,
      status: "idle",
      config: input.config || {},
      createdAt: new Date(),
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  updateAgent(id: string, updates: Partial<Agent>): Agent | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;

    const updated = { ...agent, ...updates, id };
    this.agents.set(id, updated);
    return updated;
  }

  deleteAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  // Task methods
  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  createTask(input: CreateTaskInput): Task {
    const now = new Date();
    const task: Task = {
      id: nanoid(),
      title: input.title,
      description: input.description,
      stage: input.stage || "backlog",
      priority: input.priority || "medium",
      assignedAgentId: input.assignedAgentId,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  updateTask(id: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const updated = {
      ...task,
      ...updates,
      id,
      updatedAt: new Date(),
    };
    this.tasks.set(id, updated);
    return updated;
  }

  deleteTask(id: string): boolean {
    return this.tasks.delete(id);
  }

  // Run methods
  getRuns(agentId?: string, taskId?: string): Run[] {
    let runs = Array.from(this.runs.values());
    if (agentId) {
      runs = runs.filter((r) => r.agentId === agentId);
    }
    if (taskId) {
      runs = runs.filter((r) => r.taskId === taskId);
    }
    return runs;
  }

  getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  createRun(input: CreateRunInput): Run {
    const run: Run = {
      id: nanoid(),
      agentId: input.agentId,
      taskId: input.taskId,
      status: "pending",
      startedAt: new Date(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  updateRun(id: string, updates: Partial<Run>): Run | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;

    const updated = { ...run, ...updates, id };
    this.runs.set(id, updated);
    return updated;
  }

  // Message methods
  getMessages(agentId: string): Message[] {
    const messageIds = this.agentMessages.get(agentId) || [];
    return messageIds
      .map((id) => this.messages.get(id))
      .filter((m): m is Message => m !== undefined)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  createMessage(input: CreateMessageInput): Message {
    const message: Message = {
      id: nanoid(),
      agentId: input.agentId,
      role: input.role,
      content: input.content,
      createdAt: new Date(),
      runId: input.runId,
    };

    this.messages.set(message.id, message);

    const messageIds = this.agentMessages.get(input.agentId) || [];
    messageIds.push(message.id);
    this.agentMessages.set(input.agentId, messageIds);

    return message;
  }

  // Metrics
  getMetrics() {
    const allRuns = Array.from(this.runs.values());
    const completedRuns = allRuns.filter((r) => r.status === "completed");
    const failedRuns = allRuns.filter((r) => r.status === "failed");
    const totalTokens = completedRuns.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
    const completedTasks = Array.from(this.tasks.values()).filter((t) => t.stage === "done").length;

    return {
      tokensSpent: totalTokens,
      tasksCompleted: completedTasks,
      errorRate: allRuns.length > 0 ? failedRuns.length / allRuns.length : 0,
      lastRun:
        allRuns.length > 0
          ? allRuns.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
          : undefined,
    };
  }
}

// Singleton instance
export const mockDb = new MockDatabase();
