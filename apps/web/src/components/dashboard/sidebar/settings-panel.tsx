"use client";

import { useSettingsStore } from "@/store";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export function SettingsPanel() {
  const chaosEnabled = useSettingsStore((state) => state.chaosEnabled);
  const taskUpdateFailureRate = useSettingsStore((state) => state.taskUpdateFailureRate);
  const agentActionFailureRate = useSettingsStore((state) => state.agentActionFailureRate);
  const setChaosEnabled = useSettingsStore((state) => state.setChaosEnabled);
  const setTaskUpdateFailureRate = useSettingsStore((state) => state.setTaskUpdateFailureRate);
  const setAgentActionFailureRate = useSettingsStore((state) => state.setAgentActionFailureRate);

  return (
    <div className="p-4 space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-4">Chaos Engineering</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="chaos-enabled" className="text-sm">
              Enable Chaos Mode
            </Label>
            <Switch id="chaos-enabled" checked={chaosEnabled} onCheckedChange={setChaosEnabled} />
          </div>

          {chaosEnabled && (
            <>
              <Separator />
              <div className="space-y-2">
                <Label htmlFor="task-failure-rate" className="text-xs">
                  Task Update Failure Rate
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="task-failure-rate"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={taskUpdateFailureRate}
                    onChange={(e) => setTaskUpdateFailureRate(parseFloat(e.target.value) || 0)}
                    className="h-8"
                  />
                  <span className="text-xs text-muted-foreground">
                    {(taskUpdateFailureRate * 100).toFixed(0)}%
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="agent-failure-rate" className="text-xs">
                  Agent Action Failure Rate
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="agent-failure-rate"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={agentActionFailureRate}
                    onChange={(e) => setAgentActionFailureRate(parseFloat(e.target.value) || 0)}
                    className="h-8"
                  />
                  <span className="text-xs text-muted-foreground">
                    {(agentActionFailureRate * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
