"use client";

import { useEffect, useRef } from "react";
import type { Message } from "@/types/message";
import {
  Message as MessageComponent,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

interface MessageListProps {
  agentId: string;
  messages: Message[];
}

export function MessageList({ agentId, messages }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No messages yet. Start a conversation!
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto" ref={scrollRef}>
      <div className="space-y-4">
        {messages.map((message) => (
          <MessageComponent key={message.id} from={message.role}>
            <MessageContent>
              <MessageResponse>{message.content}</MessageResponse>
            </MessageContent>
          </MessageComponent>
        ))}
      </div>
    </div>
  );
}
