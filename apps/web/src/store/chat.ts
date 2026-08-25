import { create } from "zustand";
import { nanoid } from "nanoid";
import { runEffect } from "@/lib/effect-runtime";
import { mockClient } from "@/api/client";
import type { Message, StreamChunk } from "@/types/message";

interface StreamingState {
  isStreaming: boolean;
  isPaused: boolean;
  controller: ReadableStreamDefaultController<StreamChunk> | null;
  streamController: { cancel: () => void; pause: () => void; resume: () => void } | null;
}

interface ChatState {
  messages: Record<string, Message[]>; // agentId -> messages
  streaming: Record<string, StreamingState>; // agentId -> streaming state
  fetchMessages: (agentId: string) => Promise<void>;
  sendMessage: (
    agentId: string,
    content: string,
    onChunk?: (chunk: string) => void,
    onComplete?: () => void,
  ) => Promise<void>;
  stopStreaming: (agentId: string) => void;
  pauseStreaming: (agentId: string) => void;
  resumeStreaming: (agentId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  streaming: {},

  fetchMessages: async (agentId) => {
    try {
      const messages = await runEffect(mockClient.chat.getMessages(agentId));
      set((state) => ({
        messages: {
          ...state.messages,
          [agentId]: messages,
        },
      }));
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    }
  },

  sendMessage: async (agentId, content, onChunk, onComplete) => {
    try {
      // Set streaming state
      set((state) => ({
        streaming: {
          ...state.streaming,
          [agentId]: {
            isStreaming: true,
            isPaused: false,
            controller: null,
            streamController: null,
          },
        },
      }));

      const result = await runEffect(mockClient.chat.sendMessage(agentId, content));
      const { messageId, stream } = result;

      // Get stream controller if available
      const streamCtrl = (stream as any).cancel
        ? {
            cancel: () => (stream as any).cancel(),
            pause: () => (stream as any).pause(),
            resume: () => (stream as any).resume(),
          }
        : null;

      if (streamCtrl) {
        set((state) => ({
          streaming: {
            ...state.streaming,
            [agentId]: {
              ...state.streaming[agentId],
              streamController: streamCtrl,
            },
          },
        }));
      }

      // Create initial assistant message
      const assistantMessage: Message = {
        id: messageId,
        agentId,
        role: "assistant",
        content: "",
        createdAt: new Date(),
      };

      set((state) => ({
        messages: {
          ...state.messages,
          [agentId]: [
            ...(state.messages[agentId] || []),
            {
              id: nanoid(),
              agentId,
              role: "user",
              content,
              createdAt: new Date(),
            },
            assistantMessage,
          ],
        },
      }));

      // Read stream
      const reader = stream.getReader();
      let accumulatedContent = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.done) {
            break;
          }

          accumulatedContent += value.content;
          onChunk?.(value.content);

          // Update message content
          set((state) => {
            const messages = state.messages[agentId] || [];
            const lastMessage = messages[messages.length - 1];
            if (lastMessage && lastMessage.role === "assistant") {
              return {
                messages: {
                  ...state.messages,
                  [agentId]: messages.map((m) =>
                    m.id === messageId ? { ...m, content: accumulatedContent } : m,
                  ),
                },
              };
            }
            return state;
          });
        }
      } finally {
        reader.releaseLock();
      }

      // Clear streaming state
      set((state) => ({
        streaming: {
          ...state.streaming,
          [agentId]: {
            isStreaming: false,
            isPaused: false,
            controller: null,
            streamController: null,
          },
        },
      }));

      onComplete?.();
    } catch (error) {
      console.error("Failed to send message:", error);
      set((state) => ({
        streaming: {
          ...state.streaming,
          [agentId]: {
            isStreaming: false,
            isPaused: false,
            controller: null,
            streamController: null,
          },
        },
      }));
    }
  },

  stopStreaming: (agentId) => {
    const streaming = get().streaming[agentId];
    if (streaming?.streamController) {
      streaming.streamController.cancel();
    }
    set((state) => ({
      streaming: {
        ...state.streaming,
        [agentId]: {
          isStreaming: false,
          isPaused: false,
          controller: null,
          streamController: null,
        },
      },
    }));
  },

  pauseStreaming: (agentId) => {
    const streaming = get().streaming[agentId];
    if (streaming?.streamController) {
      streaming.streamController.pause();
      set((state) => ({
        streaming: {
          ...state.streaming,
          [agentId]: {
            ...state.streaming[agentId],
            isPaused: true,
          },
        },
      }));
    }
  },

  resumeStreaming: (agentId) => {
    const streaming = get().streaming[agentId];
    if (streaming?.streamController) {
      streaming.streamController.resume();
      set((state) => ({
        streaming: {
          ...state.streaming,
          [agentId]: {
            ...state.streaming[agentId],
            isPaused: false,
          },
        },
      }));
    }
  },
}));
