import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createOrganization } from "../services/organization.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Agent Quota Enforcement", () => {
  const getApp = useTestApp();

  it("allows unlimited agents when maxAgents=0", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `quota-u-${Date.now()}` });

    // Default org has maxAgents=0 (unlimited)
    for (let i = 0; i < 5; i++) {
      await createAgent(app.db, {
        name: `unlimited-${i}`,
        type: "autonomous_agent",
        managerId: ctx.memberId,
        clientId: ctx.clientId,
      });
    }
  });

  it("enforces agent limit when maxAgents > 0", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `quota-l-${Date.now()}` });

    const org = await createOrganization(app.db, { name: "limited-org", displayName: "Limited", maxAgents: 2 });

    await createAgent(app.db, {
      name: "slot-1",
      type: "human",
      organizationId: org.id,
      managerId: ctx.memberId,
    });
    await createAgent(app.db, {
      name: "slot-2",
      type: "human",
      organizationId: org.id,
      managerId: ctx.memberId,
    });

    await expect(
      createAgent(app.db, {
        name: "slot-3",
        type: "human",
        organizationId: org.id,
        managerId: ctx.memberId,
      }),
    ).rejects.toThrow(/agent limit/i);
  });

  it("does not count deleted agents toward quota", async () => {
    const app = getApp();
    const { suspendAgent, deleteAgent } = await import("../services/agent.js");
    const ctx = await createAdminContext(app, { username: `quota-d-${Date.now()}` });

    const org = await createOrganization(app.db, { name: "quota-del-org", displayName: "Quota Del", maxAgents: 1 });

    const agent = await createAgent(app.db, {
      name: "temp",
      type: "human",
      organizationId: org.id,
      managerId: ctx.memberId,
    });
    await suspendAgent(app.db, agent.uuid);
    await deleteAgent(app.db, agent.uuid);

    const newAgent = await createAgent(app.db, {
      name: "replacement",
      type: "human",
      organizationId: org.id,
      managerId: ctx.memberId,
    });
    expect(newAgent.name).toBe("replacement");
  });
});
