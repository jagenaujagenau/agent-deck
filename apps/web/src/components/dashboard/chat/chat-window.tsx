"use client";

import { useEffect, useRef } from "react";
import { Rnd } from "react-rnd";
import type { Agent } from "@/types/agent";
import { useWindowsStore, useChatStore } from "@/store";
import { Button } from "@/components/ui/button";
import { XIcon, MinusIcon, SquareIcon, PauseIcon, PlayIcon } from "lucide-react";
import { MessageList } from "./message-list";
import { PromptInput } from "@/components/ai-elements/prompt-input";
import { PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ChatWindowProps {
  agent: Agent;
}

export function ChatWindow({ agent }: ChatWindowProps) {
  const window = useWindowsStore((state) => state.windows[agent.id]);
  const updateWindowPosition = useWindowsStore((state) => state.updateWindowPosition);
  const focusWindow = useWindowsStore((state) => state.focusWindow);
  const closeWindow = useWindowsStore((state) => state.closeWindow);
  const minimizeWindow = useWindowsStore((state) => state.minimizeWindow);
  const restoreWindow = useWindowsStore((state) => state.restoreWindow);

  const messages = useChatStore((state) => state.messages[agent.id] || []);
  const streaming = useChatStore((state) => state.streaming[agent.id]);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopStreaming = useChatStore((state) => state.stopStreaming);
  const pauseStreaming = useChatStore((state) => state.pauseStreaming);
  const resumeStreaming = useChatStore((state) => state.resumeStreaming);
  const fetchMessages = useChatStore((state) => state.fetchMessages);

  const isStreaming = streaming?.isStreaming ?? false;
  const isPaused = streaming?.isPaused ?? false;

  useEffect(() => {
    fetchMessages(agent.id);
  }, [agent.id, fetchMessages]);

  if (!window) return null;

  const handleDragStart = () => {
    focusWindow(agent.id);
  };

  const handleResizeStart = () => {
    focusWindow(agent.id);
  };

  const handleSubmit = async (message: { text: string; files: any[] }) => {
    if (!message.text.trim()) return;

    await sendMessage(
      agent.id,
      message.text,
      undefined, // onChunk
      () => {
        fetchMessages(agent.id);
      },
    );
  };

  if (window.minimized) {
    return (
      <Rnd
        position={{ x: window.x, y: window.y }}
        size={{ width: 300, height: 40 }}
        minWidth={300}
        minHeight={40}
        bounds="window"
        style={{ zIndex: window.zIndex }}
        onDragStart={handleDragStart}
        onDragStop={(e, d) => {
          updateWindowPosition(agent.id, { x: d.x, y: d.y });
        }}
        className="pointer-events-auto"
      >
        <div
          className="h-full bg-card border rounded-lg shadow-lg flex items-center justify-between px-4 cursor-move"
          onClick={() => restoreWindow(agent.id)}
        >
          <span className="text-sm font-medium">{agent.name}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              closeWindow(agent.id);
            }}
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
      </Rnd>
    );
  }

  return (
    <Rnd
      position={{ x: window.x, y: window.y }}
      size={{ width: window.width, height: window.height }}
      minWidth={400}
      minHeight={300}
      bounds="window"
      style={{ zIndex: window.zIndex }}
      onDragStart={handleDragStart}
      onResizeStart={handleResizeStart}
      onDragStop={(e, d) => {
        updateWindowPosition(agent.id, { x: d.x, y: d.y });
      }}
      onResizeStop={(e, direction, ref, delta, position) => {
        updateWindowPosition(agent.id, {
          width: ref.offsetWidth,
          height: ref.offsetHeight,
          x: position.x,
          y: position.y,
        });
      }}
      className="pointer-events-auto"
    >
      <div className="h-full bg-card border rounded-lg shadow-lg flex flex-col">
        {/* Header */}
        <div
          className="flex items-center justify-between p-3 border-b cursor-move"
          onMouseDown={() => focusWindow(agent.id)}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{agent.name}</h3>
            {isStreaming && <span className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />}
          </div>
          <div className="flex items-center gap-1">
            {isStreaming && (
              <>
                {isPaused ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => resumeStreaming(agent.id)}
                    title="Resume"
                  >
                    <PlayIcon className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => pauseStreaming(agent.id)}
                    title="Pause"
                  >
                    <PauseIcon className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => stopStreaming(agent.id)}
                  title="Stop"
                >
                  <SquareIcon className="h-4 w-4" />
                </Button>
              </>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => minimizeWindow(agent.id)}
              title="Minimize"
            >
              <MinusIcon className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => closeWindow(agent.id)}
              title="Close"
            >
              <XIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto p-4">
          <MessageList agentId={agent.id} messages={messages} />
        </div>

        {/* Input */}
        <div className="border-t p-4">
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputTextarea placeholder={`Message ${agent.name}...`} />
            <PromptInputFooter>
              <PromptInputSubmit
                status={isStreaming ? "streaming" : undefined}
                onStop={() => stopStreaming(agent.id)}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </Rnd>
  );
}
