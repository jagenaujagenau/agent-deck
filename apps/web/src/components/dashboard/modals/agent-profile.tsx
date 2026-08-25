"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { runEffect } from "@/lib/effect-runtime";
import { mockClient } from "@/api/client";
import type { AgentProfileStats } from "@/types/agent";
import { useAgentsStore } from "@/store";
import { formatDistanceToNow } from "date-fns";

interface AgentProfileModalProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentProfileModal({ agentId, open, onOpenChange }: AgentProfileModalProps) {
  const agents = useAgentsStore((state) => state.agents);
  const agent = agents.find((a) => a.id === agentId);
  const [stats, setStats] = useState<AgentProfileStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && agentId) {
      setLoading(true);
      runEffect(mockClient.agents.profileStats(agentId))
        .then(setStats)
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [open, agentId]);

  if (!agent) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{agent.name} - Profile</DialogTitle>
          <DialogDescription>Agent statistics and performance</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          <div>
            <h3 className="text-sm font-semibold mb-2">Agent Information</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Model:</span>
                <span className="font-medium">{agent.model}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status:</span>
                <span className="font-medium capitalize">{agent.status}</span>
              </div>
              {agent.lastRunAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last Run:</span>
                  <span className="font-medium">
                    {formatDistanceToNow(agent.lastRunAt, { addSuffix: true })}
                  </span>
                </div>
              )}
            </div>
          </div>

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : stats ? (
            <>
              <div>
                <h3 className="text-sm font-semibold mb-4">Statistics</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 border rounded-lg">
                    <div className="text-2xl font-bold">{stats.totalRuns}</div>
                    <div className="text-xs text-muted-foreground">Total Runs</div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-2xl font-bold text-green-600">{stats.successfulRuns}</div>
                    <div className="text-xs text-muted-foreground">Successful</div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-2xl font-bold text-red-600">{stats.failedRuns}</div>
                    <div className="text-xs text-muted-foreground">Failed</div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-2xl font-bold">{stats.tasksCompleted}</div>
                    <div className="text-xs text-muted-foreground">Tasks Completed</div>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-4">Performance</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Tokens Used:</span>
                    <span className="font-medium">{stats.totalTokensUsed.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Average Response Time:</span>
                    <span className="font-medium">
                      {stats.averageResponseTime > 0
                        ? `${(stats.averageResponseTime / 1000).toFixed(2)}s`
                        : "N/A"}
                    </span>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
