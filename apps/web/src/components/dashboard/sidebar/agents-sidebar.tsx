"use client";

import { useState } from "react";
import { AgentsList } from "./agents-list";
import { QuickStats } from "./quick-stats";
import { SettingsPanel } from "./settings-panel";
import { Button } from "@/components/ui/button";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { NewAgentDialog } from "./new-agent-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RefObject } from "react";
import { useRef } from "react";

interface AgentsSidebarProps {
  searchInputRef?: RefObject<HTMLInputElement>;
}

export function AgentsSidebar({ searchInputRef: externalRef }: AgentsSidebarProps) {
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const [activeTab, setActiveTab] = useState("agents");
  const internalRef = useRef<HTMLInputElement>(null);
  const searchInputRef = externalRef || internalRef;

  return (
    <aside className="flex h-full w-80 flex-col border-r bg-sidebar">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="text-lg font-semibold">Agents</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setShowNewAgentDialog(true)}
          title="New Agent"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="grid w-full grid-cols-2 m-2">
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="flex-1 flex flex-col m-0">
          <div className="flex-1 overflow-auto">
            <AgentsList searchInputRef={searchInputRef as React.RefObject<HTMLInputElement>} />
          </div>
          <div className="border-t p-4">
            <QuickStats />
          </div>
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto m-0">
          <SettingsPanel />
        </TabsContent>
      </Tabs>

      <NewAgentDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
      />
    </aside>
  );
}
