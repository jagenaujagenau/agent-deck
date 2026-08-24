import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    // Redirect to dashboard if logged in, otherwise to login
    const sessionStr = localStorage.getItem("session");
    redirect({
      to: sessionStr ? "/dashboard" : "/login",
      throw: true,
    });
  },
});
