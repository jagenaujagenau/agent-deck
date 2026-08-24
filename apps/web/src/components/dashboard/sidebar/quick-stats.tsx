"use client";

import { useEffect, useState } from "react";
import { runEffect } from "@/lib/effect-runtime";
import { mockClient } from "@/api/client";
import { Skeleton } from "@/components/ui/skeleton";

export function QuickStats() {
  const [stats, setStats] = useState<{
    tokensSpent: number;
    tasksCompleted: number;
    errorRate: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      try {
        const metrics = await runEffect(mockClient.metrics.summary());
        setStats({
          tokensSpent: metrics.tokensSpent,
          tasksCompleted: metrics.tasksCompleted,
          errorRate: metrics.errorRate,
        });
      } catch (error) {
        console.error("Failed to load stats:", error);
      } finally {
        setLoading(false);
      }
    };

    loadStats();
    const interval = setInterval(loadStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-2 text-xs">
      <div className="flex justify-between">
        <span className="text-muted-foreground">Tokens Spent:</span>
        <span className="font-medium">{stats.tokensSpent.toLocaleString()}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Tasks Completed:</span>
        <span className="font-medium">{stats.tasksCompleted}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Error Rate:</span>
        <span className="font-medium">{(stats.errorRate * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}
