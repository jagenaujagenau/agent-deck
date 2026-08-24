import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWindowsStore } from "@/store";
import { DashboardLayout } from "@/components/dashboard/layout";

export const Route = createFileRoute("/agents/$id")({
  component: RouteComponent,
  beforeLoad: () => {
    // Mock auth check
    const sessionStr = localStorage.getItem("session");
    if (!sessionStr) {
      redirect({
        to: "/login",
        throw: true,
      });
    }
  },
});

function RouteComponent() {
  const { id } = Route.useParams();
  const openWindow = useWindowsStore((state) => state.openWindow);
  const focusWindow = useWindowsStore((state) => state.focusWindow);

  useEffect(() => {
    // Open and focus the chat window for this agent
    openWindow(id);
    setTimeout(() => focusWindow(id), 100);
  }, [id, openWindow, focusWindow]);

  return <DashboardLayout />;
}
