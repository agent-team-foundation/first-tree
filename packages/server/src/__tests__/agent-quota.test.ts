import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createMember } from "../services/member.js";
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
        type: "agent",
        managerId: ctx.memberId,
        clientId: ctx.clientId,
      });
    }
  });

  it("enforces agent limit when maxAgents > 0", async () => {
    const app = getApp();
    await createAdminContext(app, { username: `quota-l-${Date.now()}` });

    const org = await createOrganization(app.db, { name: "limited-org", displayName: "Limited", maxAgents: 3 });
    const owner = await createMember(app.db, org.id, {
      username: `quota-owner-${Date.now()}`,
      displayName: "Quota Owner",
      role: "admin",
    });

    await createAgent(app.db, {
      name: "slot-1",
      type: "agent",
      organizationId: org.id,
      managerId: owner.id,
    });
    await createAgent(app.db, {
      name: "slot-2",
      type: "agent",
      organizationId: org.id,
      managerId: owner.id,
    });

    await expect(
      createAgent(app.db, {
        name: "slot-3",
        type: "agent",
        organizationId: org.id,
        managerId: owner.id,
      }),
    ).rejects.toThrow(/agent limit/i);
  });

  it("does not count deleted agents toward quota", async () => {
    const app = getApp();
    const { suspendAgent, deleteAgent } = await import("../services/agent.js");
    await createAdminContext(app, { username: `quota-d-${Date.now()}` });

    const org = await createOrganization(app.db, { name: "quota-del-org", displayName: "Quota Del", maxAgents: 2 });
    const owner = await createMember(app.db, org.id, {
      username: `quota-del-owner-${Date.now()}`,
      displayName: "Quota Del Owner",
      role: "admin",
    });

    const agent = await createAgent(app.db, {
      name: "temp",
      type: "agent",
      organizationId: org.id,
      managerId: owner.id,
    });
    await suspendAgent(app.db, agent.uuid);
    await deleteAgent(app.db, agent.uuid);

    const newAgent = await createAgent(app.db, {
      name: "replacement",
      type: "agent",
      organizationId: org.id,
      managerId: owner.id,
    });
    expect(newAgent.name).toBe("replacement");
  });
});
