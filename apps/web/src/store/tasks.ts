import { create } from "zustand";
import { runEffect } from "@/lib/effect-runtime";
import { mockClient } from "@/api/client";
import type { Task, CreateTaskInput, UpdateTaskInput, TaskStage } from "@/types/task";

interface TasksState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  optimisticUpdate: {
    taskId: string;
    fromStage: TaskStage;
    toStage: TaskStage;
  } | null;
  fetchTasks: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task | null>;
  updateTask: (id: string, input: UpdateTaskInput) => Promise<Task | null>;
  deleteTask: (id: string) => Promise<boolean>;
  moveTask: (id: string, newStage: TaskStage) => Promise<boolean>;
  setOptimisticUpdate: (
    update: {
      taskId: string;
      fromStage: TaskStage;
      toStage: TaskStage;
    } | null,
  ) => void;
  rollbackOptimisticUpdate: () => void;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  optimisticUpdate: null,

  fetchTasks: async () => {
    set({ loading: true, error: null });
    try {
      const tasks = await runEffect(mockClient.tasks.list());
      set({ tasks, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to fetch tasks",
        loading: false,
      });
    }
  },

  createTask: async (input) => {
    set({ error: null });
    try {
      const task = await runEffect(mockClient.tasks.create(input));
      set((state) => ({
        tasks: [...state.tasks, task],
      }));
      return task;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to create task",
      });
      return null;
    }
  },

  updateTask: async (id, input) => {
    set({ error: null });
    try {
      const task = await runEffect(mockClient.tasks.update(id, input));
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? task : t)),
      }));
      return task;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update task",
      });
      return null;
    }
  },

  deleteTask: async (id) => {
    set({ error: null });
    try {
      await runEffect(mockClient.tasks.delete(id));
      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== id),
      }));
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete task",
      });
      return false;
    }
  },

  moveTask: async (id, newStage) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return false;

    // Optimistic update
    set({
      optimisticUpdate: { taskId: id, fromStage: task.stage, toStage: newStage },
    });
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, stage: newStage } : t)),
    }));

    try {
      const updated = await runEffect(mockClient.tasks.update(id, { stage: newStage }));
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
        optimisticUpdate: null,
      }));
      return true;
    } catch (error) {
      // Rollback on error
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? { ...t, stage: task.stage } : t)),
        optimisticUpdate: null,
        error: error instanceof Error ? error.message : "Failed to move task",
      }));
      return false;
    }
  },

  setOptimisticUpdate: (update) => {
    set({ optimisticUpdate: update });
  },

  rollbackOptimisticUpdate: () => {
    const { optimisticUpdate, tasks } = get();
    if (!optimisticUpdate) return;

    set({
      tasks: tasks.map((t) =>
        t.id === optimisticUpdate.taskId ? { ...t, stage: optimisticUpdate.fromStage } : t,
      ),
      optimisticUpdate: null,
    });
  },
}));
