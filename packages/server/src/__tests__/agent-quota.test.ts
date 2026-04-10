import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createOrganization } from "../services/organization.js";
import { useTestApp } from "./helpers.js";

describe("Agent Quota Enforcement", () => {
  const getApp = useTestApp();

  it("allows unlimited agents when maxAgents=0", async () => {
    const app = getApp();

    // Default org has maxAgents=0 (unlimited)
    for (let i = 0; i < 5; i++) {
      await createAgent(app.db, { name: `unlimited-${i}`, type: "autonomous_agent" });
    }
    // No error — all created
  });

  it("enforces agent limit when maxAgents > 0", async () => {
    const app = getApp();

    const org = await createOrganization(app.db, { name: "limited-org", displayName: "Limited", maxAgents: 2 });

    await createAgent(app.db, { name: "slot-1", type: "human", organizationId: org.id });
    await createAgent(app.db, { name: "slot-2", type: "human", organizationId: org.id });

    // Third agent should fail
    await expect(createAgent(app.db, { name: "slot-3", type: "human", organizationId: org.id })).rejects.toThrow(
      /agent limit/i,
    );
  });

  it("does not count deleted agents toward quota", async () => {
    const app = getApp();
    const { suspendAgent, deleteAgent } = await import("../services/agent.js");

    const org = await createOrganization(app.db, { name: "quota-del-org", displayName: "Quota Del", maxAgents: 1 });

    const agent = await createAgent(app.db, { name: "temp", type: "human", organizationId: org.id });
    await suspendAgent(app.db, agent.uuid);
    await deleteAgent(app.db, agent.uuid);

    // Slot freed — can create again
    const newAgent = await createAgent(app.db, { name: "replacement", type: "human", organizationId: org.id });
    expect(newAgent.name).toBe("replacement");
  });
});
