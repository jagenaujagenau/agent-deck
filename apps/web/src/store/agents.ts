import { create } from "zustand";
import { runEffect } from "@/lib/effect-runtime";
import { mockClient } from "@/api/client";
import type { Agent, CreateAgentInput, UpdateAgentInput } from "@/types/agent";

interface AgentsState {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  createAgent: (input: CreateAgentInput) => Promise<Agent | null>;
  updateAgent: (id: string, input: UpdateAgentInput) => Promise<Agent | null>;
  deleteAgent: (id: string) => Promise<boolean>;
  runAgent: (id: string, taskId?: string) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
  pauseAgent: (id: string) => Promise<void>;
  resumeAgent: (id: string) => Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const agents = await runEffect(mockClient.agents.list());
      set({ agents, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to fetch agents",
        loading: false,
      });
    }
  },

  createAgent: async (input) => {
    set({ error: null });
    try {
      const agent = await runEffect(mockClient.agents.create(input));
      set((state) => ({
        agents: [...state.agents, agent],
      }));
      return agent;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to create agent",
      });
      return null;
    }
  },

  updateAgent: async (id, input) => {
    set({ error: null });
    try {
      const agent = await runEffect(mockClient.agents.update(id, input));
      set((state) => ({
        agents: state.agents.map((a) => (a.id === id ? agent : a)),
      }));
      return agent;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update agent",
      });
      return null;
    }
  },

  deleteAgent: async (id) => {
    set({ error: null });
    try {
      await runEffect(mockClient.agents.delete(id));
      set((state) => ({
        agents: state.agents.filter((a) => a.id !== id),
      }));
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete agent",
      });
      return false;
    }
  },

  runAgent: async (id, taskId) => {
    set({ error: null });
    try {
      await runEffect(mockClient.agents.run(id, taskId));
      await get().fetchAgents(); // Refresh to get updated status
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to run agent",
      });
    }
  },

  stopAgent: async (id) => {
    set({ error: null });
    try {
      await runEffect(mockClient.agents.stop(id));
      await get().fetchAgents();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to stop agent",
      });
    }
  },

  pauseAgent: async (id) => {
    set({ error: null });
    try {
      await runEffect(mockClient.agents.pause(id));
      await get().fetchAgents();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to pause agent",
      });
    }
  },

  resumeAgent: async (id) => {
    set({ error: null });
    try {
      await runEffect(mockClient.agents.resume(id));
      await get().fetchAgents();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to resume agent",
      });
    }
  },
}));
