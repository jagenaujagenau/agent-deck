"use client";

import { useState, useEffect, type RefObject } from "react";
import { useAgentsStore } from "@/store";
import { AgentItem } from "./agent-item";
import { Input } from "@/components/ui/input";
import { SearchIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface AgentsListProps {
  searchInputRef?: RefObject<HTMLInputElement>;
}

export function AgentsList({ searchInputRef }: AgentsListProps) {
  const agents = useAgentsStore((state) => state.agents);
  const loading = useAgentsStore((state) => state.loading);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredAgents = agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      agent.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  if (loading && agents.length === 0) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder="Search agents... (Press / to focus)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {filteredAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8 text-muted-foreground">
            <p className="text-sm">{searchQuery ? "No agents found" : "No agents yet"}</p>
            <p className="text-xs mt-2">
              {searchQuery
                ? "Try a different search term"
                : "Create your first agent to get started"}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredAgents.map((agent) => (
              <AgentItem key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
