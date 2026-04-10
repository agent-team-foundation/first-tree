import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import * as clientService from "../services/client.js";
import * as presenceService from "../services/presence.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Unit tests for client.ts service layer — DB-backed.
 *
 * Focus: disconnectClient must not corrupt agents that were re-bound
 * to a different client.
 */

describe("client service: disconnectClient", () => {
  const getApp = useTestApp();

  it("sets agents with matching clientId to offline", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `cs-dc-1-${crypto.randomUUID().slice(0, 6)}` });

    const clientId = `client-dc-1-${Date.now()}`;
    await clientService.registerClient(app.db, { clientId, instanceId: "test" });
    await presenceService.bindAgent(app.db, agent.uuid, {
      clientId,
      instanceId: "test",
      runtimeType: "test",
    });

    await clientService.disconnectClient(app.db, clientId);

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("offline");
    expect(presence?.clientId).toBeNull();
    expect(presence?.runtimeState).toBeNull();
  });

  it("does not affect agents re-bound to a different client", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `cs-dc-2-${crypto.randomUUID().slice(0, 6)}` });

    const oldClient = `client-dc-old-${Date.now()}`;
    const newClient = `client-dc-new-${Date.now()}`;
    await clientService.registerClient(app.db, { clientId: oldClient, instanceId: "test" });
    await clientService.registerClient(app.db, { clientId: newClient, instanceId: "test" });

    // Bind to old client first
    await presenceService.bindAgent(app.db, agent.uuid, {
      clientId: oldClient,
      instanceId: "test",
      runtimeType: "test",
    });

    // Re-bind to new client (upsert overwrites clientId)
    await presenceService.bindAgent(app.db, agent.uuid, {
      clientId: newClient,
      instanceId: "test",
      runtimeType: "test",
    });

    // Disconnect old client — agent's clientId is now newClient, so it must NOT be affected
    await clientService.disconnectClient(app.db, oldClient);

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("online");
    expect(presence?.clientId).toBe(newClient);
    expect(presence?.runtimeState).toBe("idle");
  });

  it("only affects agents of the disconnected client, not others", async () => {
    const app = getApp();
    const { agent: agentA } = await createTestAgent(app, { name: `cs-dc-3a-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: agentB } = await createTestAgent(app, { name: `cs-dc-3b-${crypto.randomUUID().slice(0, 6)}` });

    const clientX = `client-dc-x-${Date.now()}`;
    const clientY = `client-dc-y-${Date.now()}`;
    await clientService.registerClient(app.db, { clientId: clientX, instanceId: "test" });
    await clientService.registerClient(app.db, { clientId: clientY, instanceId: "test" });

    await presenceService.bindAgent(app.db, agentA.uuid, {
      clientId: clientX,
      instanceId: "test",
      runtimeType: "test",
    });
    await presenceService.bindAgent(app.db, agentB.uuid, {
      clientId: clientY,
      instanceId: "test",
      runtimeType: "test",
    });

    // Disconnect clientX — agentB on clientY must not be affected
    await clientService.disconnectClient(app.db, clientX);

    const [presA] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agentA.uuid));
    const [presB] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agentB.uuid));

    expect(presA?.status).toBe("offline");
    expect(presB?.status).toBe("online");
    expect(presB?.clientId).toBe(clientY);
  });
});
