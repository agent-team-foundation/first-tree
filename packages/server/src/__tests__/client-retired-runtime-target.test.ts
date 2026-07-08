import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { ClientRetiredError } from "../errors.js";
import { createAgent, updateAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("retired clients as runtime targets", () => {
  const getApp = useTestApp();

  async function seedRetiredClient() {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `retired-target-${crypto.randomUUID().slice(0, 8)}` });
    const clientId = `retired-target-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      retiredAt: new Date(),
      metadata: {
        capabilities: { "claude-code": { state: "ok", available: true, detectedAt: new Date().toISOString() } },
      },
    });
    return { app, admin, clientId };
  }

  it("rejects direct agent creation on a retired client", async () => {
    const { app, admin, clientId } = await seedRetiredClient();

    await expect(
      createAgent(app.db, {
        name: `retired-create-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        displayName: "Retired Create",
        managerId: admin.memberId,
        clientId,
      }),
    ).rejects.toBeInstanceOf(ClientRetiredError);

    const rows = await app.db.select({ uuid: agents.uuid }).from(agents).where(eq(agents.clientId, clientId));
    expect(rows).toEqual([]);
  });

  it("rejects direct first-bind update on a retired client", async () => {
    const { app, admin, clientId } = await seedRetiredClient();
    const agent = await createAgent(app.db, {
      name: `retired-update-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Retired Update",
      managerId: admin.memberId,
    });

    await expect(updateAgent(app.db, agent.uuid, { clientId })).rejects.toBeInstanceOf(ClientRetiredError);

    const [row] = await app.db.select({ clientId: agents.clientId }).from(agents).where(eq(agents.uuid, agent.uuid));
    expect(row?.clientId).toBeNull();
  });
});
