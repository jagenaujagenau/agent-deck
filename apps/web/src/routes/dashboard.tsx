import { createFileRoute, redirect } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard/layout";

export const Route = createFileRoute("/dashboard")({
  component: RouteComponent,
  beforeLoad: () => {
    // Mock auth check - just check localStorage
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
  return <DashboardLayout />;
}
