import { afterAll, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createOrganization } from "../services/organization.js";
import { createTestApp } from "./helpers.js";

describe("Agent Quota Enforcement", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("allows unlimited agents when maxAgents=0", async () => {
    const app = await appPromise;

    // Default org has maxAgents=0 (unlimited)
    for (let i = 0; i < 5; i++) {
      await createAgent(app.db, { name: `unlimited-${i}`, type: "autonomous_agent" });
    }
    // No error — all created
  });

  it("enforces agent limit when maxAgents > 0", async () => {
    const app = await appPromise;

    await createOrganization(app.db, { id: "limited-org", displayName: "Limited", maxAgents: 2 });

    await createAgent(app.db, { name: "slot-1", type: "human", organizationId: "limited-org" });
    await createAgent(app.db, { name: "slot-2", type: "human", organizationId: "limited-org" });

    // Third agent should fail
    await expect(createAgent(app.db, { name: "slot-3", type: "human", organizationId: "limited-org" })).rejects.toThrow(
      /agent limit/i,
    );
  });

  it("does not count deleted agents toward quota", async () => {
    const app = await appPromise;
    const { suspendAgent, deleteAgent } = await import("../services/agent.js");

    await createOrganization(app.db, { id: "quota-del-org", displayName: "Quota Del", maxAgents: 1 });

    const agent = await createAgent(app.db, { name: "temp", type: "human", organizationId: "quota-del-org" });
    await suspendAgent(app.db, agent.uuid);
    await deleteAgent(app.db, agent.uuid);

    // Slot freed — can create again
    const newAgent = await createAgent(app.db, { name: "replacement", type: "human", organizationId: "quota-del-org" });
    expect(newAgent.name).toBe("replacement");
  });
});
