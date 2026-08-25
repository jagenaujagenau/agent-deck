import { describe, it, expect, beforeEach } from "vitest";
import { useAgentsStore } from "../agents";
import { mockDb } from "@/api/mock-db";

describe("Agents Store", () => {
  beforeEach(() => {
    // Reset store state
    useAgentsStore.setState({
      agents: [],
      loading: false,
      error: null,
    });
  });

  it("should fetch agents", async () => {
    const store = useAgentsStore.getState();
    await store.fetchAgents();

    const agents = useAgentsStore.getState().agents;
    expect(agents.length).toBeGreaterThan(0);
  });

  it("should create an agent", async () => {
    const store = useAgentsStore.getState();
    const agent = await store.createAgent({
      name: "Test Agent",
      description: "Test Description",
      model: "gpt-4",
    });

    expect(agent).not.toBeNull();
    expect(agent?.name).toBe("Test Agent");
    expect(useAgentsStore.getState().agents).toContainEqual(
      expect.objectContaining({ name: "Test Agent" }),
    );
  });

  it("should update an agent", async () => {
    const store = useAgentsStore.getState();
    await store.fetchAgents();
    const agent = useAgentsStore.getState().agents[0];

    if (agent) {
      const updated = await store.updateAgent(agent.id, {
        name: "Updated Name",
      });

      expect(updated?.name).toBe("Updated Name");
    }
  });

  it("should delete an agent", async () => {
    const store = useAgentsStore.getState();
    await store.fetchAgents();
    const agent = useAgentsStore.getState().agents[0];

    if (agent) {
      const success = await store.deleteAgent(agent.id);
      expect(success).toBe(true);
      expect(useAgentsStore.getState().agents.find((a) => a.id === agent.id)).toBeUndefined();
    }
  });
});
