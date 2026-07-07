import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { retireClient } from "../services/client.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("retireClient service-layer guard", () => {
  const getApp = useTestApp();

  it("suspends and unpins non-deleted agents while retiring", async () => {
    const app = getApp();
    const { agent, clientId } = await createTestAgent(app);
    await app.db
      .update(agents)
      .set({ metadata: { runtimeSession: { clientId }, runtimeSwitch: { claimId: "test-claim" } } })
      .where(eq(agents.uuid, agent.uuid));

    await expect(retireClient(app.db, clientId)).resolves.toBeUndefined();

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.status).toBe("disconnected");
    expect(row?.instanceId).toBeNull();
    expect(row?.retiredAt).toBeInstanceOf(Date);

    const [agentRow] = await app.db.select().from(agents).where(eq(agents.uuid, agent.uuid)).limit(1);
    expect(agentRow?.status).toBe("suspended");
    expect(agentRow?.clientId).toBeNull();
    expect((agentRow?.metadata as Record<string, unknown>).runtimeSession).toBeUndefined();
    expect((agentRow?.metadata as Record<string, unknown>).runtimeSwitch).toBeUndefined();
  });

  it("clears deleted-agent pins while retiring", async () => {
    const app = getApp();
    const { agent, clientId } = await createTestAgent(app);
    await app.db.update(agents).set({ status: "deleted", name: null }).where(eq(agents.uuid, agent.uuid));
    await expect(retireClient(app.db, clientId)).resolves.toBeUndefined();

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row).toBeDefined();
    expect(row?.status).toBe("disconnected");
    expect(row?.instanceId).toBeNull();
    expect(row?.retiredAt).toBeInstanceOf(Date);

    const [agentRow] = await app.db.select().from(agents).where(eq(agents.uuid, agent.uuid)).limit(1);
    expect(agentRow?.status).toBe("deleted");
    expect(agentRow?.clientId).toBeNull();
  });

  it("is idempotent and repairs pins for an already-retired client", async () => {
    const app = getApp();
    const { agent, clientId } = await createTestAgent(app);
    await retireClient(app.db, clientId);

    const [before] = await app.db
      .select({ retiredAt: clients.retiredAt })
      .from(clients)
      .where(eq(clients.id, clientId));
    await app.db
      .update(agents)
      .set({ status: "active", clientId, metadata: { runtimeSession: { clientId } } })
      .where(eq(agents.uuid, agent.uuid));

    await expect(retireClient(app.db, clientId)).resolves.toBeUndefined();
    const [after] = await app.db.select({ retiredAt: clients.retiredAt }).from(clients).where(eq(clients.id, clientId));
    expect(after?.retiredAt?.toISOString()).toBe(before?.retiredAt?.toISOString());

    const [agentRow] = await app.db.select().from(agents).where(eq(agents.uuid, agent.uuid)).limit(1);
    expect(agentRow?.status).toBe("suspended");
    expect(agentRow?.clientId).toBeNull();
    expect((agentRow?.metadata as Record<string, unknown>).runtimeSession).toBeUndefined();
  });
});
