import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { createAgent, suspendAgent } from "../services/agent.js";
import * as clientService from "../services/client.js";
import * as presenceService from "../services/presence.js";
import { recordClientHeartbeat } from "../services/runtime-liveness.js";
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
    const { agent, userId, organizationId } = await createTestAgent(app, {
      name: `cs-dc-1-${crypto.randomUUID().slice(0, 6)}`,
    });

    const clientId = `client-dc-1-${Date.now()}`;
    await clientService.registerClient(app.db, { clientId, userId, organizationId, instanceId: "test" });
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
    const { agent, userId, organizationId } = await createTestAgent(app, {
      name: `cs-dc-2-${crypto.randomUUID().slice(0, 6)}`,
    });

    const oldClient = `client-dc-old-${Date.now()}`;
    const newClient = `client-dc-new-${Date.now()}`;
    await clientService.registerClient(app.db, { clientId: oldClient, userId, organizationId, instanceId: "test" });
    await clientService.registerClient(app.db, { clientId: newClient, userId, organizationId, instanceId: "test" });

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
    const {
      agent: agentA,
      userId,
      organizationId,
    } = await createTestAgent(app, {
      name: `cs-dc-3a-${crypto.randomUUID().slice(0, 6)}`,
    });
    const { agent: agentB } = await createTestAgent(app, { name: `cs-dc-3b-${crypto.randomUUID().slice(0, 6)}` });

    const clientX = `client-dc-x-${Date.now()}`;
    const clientY = `client-dc-y-${Date.now()}`;
    await clientService.registerClient(app.db, { clientId: clientX, userId, organizationId, instanceId: "test" });
    await clientService.registerClient(app.db, { clientId: clientY, userId, organizationId, instanceId: "test" });

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

describe("client service: pinned agent startup surfaces", () => {
  const getApp = useTestApp();

  it("excludes suspended agents from startup candidate lists", async () => {
    const app = getApp();
    const {
      agent: active,
      userId,
      clientId,
      memberId,
      organizationId,
    } = await createTestAgent(app, {
      name: `cs-pin-active-${crypto.randomUUID().slice(0, 6)}`,
    });
    const suspended = await createAgent(app.db, {
      name: `cs-pin-suspended-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      source: "admin-api",
      managerId: memberId,
      organizationId,
      clientId,
    });
    await suspendAgent(app.db, suspended.uuid);

    await expect(clientService.listActiveAgentsPinnedToClient(app.db, clientId)).resolves.toEqual([
      expect.objectContaining({ uuid: active.uuid }),
    ]);
    await expect(clientService.listMyPinnedAgents(app.db, { userId })).resolves.toEqual([
      expect.objectContaining({ agentId: active.uuid, clientId, status: "active" }),
      expect.objectContaining({ agentId: suspended.uuid, clientId, status: "suspended" }),
    ]);
  });
});

describe("runtime liveness: recordClientHeartbeat", () => {
  const getApp = useTestApp();

  it("restores client and routed agent reachability after stale cleanup without overwriting runtime activity", async () => {
    const app = getApp();
    const { agent, userId, organizationId, clientId } = await createTestAgent(app, {
      name: `cs-hb-restore-${crypto.randomUUID().slice(0, 6)}`,
    });

    await clientService.registerClient(app.db, {
      clientId,
      userId,
      organizationId,
      instanceId: "current-instance",
    });
    await presenceService.bindAgent(app.db, agent.uuid, {
      clientId,
      instanceId: "current-instance",
      runtimeType: "test",
    });

    const staleAt = new Date(Date.now() - 120_000);
    await app.db.update(clients).set({ lastSeenAt: staleAt }).where(eq(clients.id, clientId));
    await expect(clientService.cleanupStaleClients(app.db, 60)).resolves.toBe(1);

    // Simulate a runtime frame arriving after the false-positive stale sweep:
    // activity may recover independently, and heartbeat must not fabricate or
    // overwrite it.
    await presenceService.setRuntimeState(app.db, agent.uuid, "working");

    const result = await recordClientHeartbeat(app.db, {
      clientId,
      instanceId: "current-instance",
      routedAgentIds: [agent.uuid],
    });

    expect(result).toEqual({ clientUpdated: true, restoredAgentIds: [agent.uuid] });

    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(client?.status).toBe("connected");
    expect(client?.instanceId).toBe("current-instance");
    expect(client?.lastSeenAt.getTime()).toBeGreaterThan(staleAt.getTime());
    expect(client?.connectedAt?.getTime()).toBeLessThan(client?.lastSeenAt.getTime() ?? 0);

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("online");
    expect(presence?.clientId).toBe(clientId);
    expect(presence?.instanceId).toBe("current-instance");
    expect(presence?.lastSeenAt.getTime()).toBeGreaterThan(staleAt.getTime());
    expect(presence?.runtimeState).toBe("working");
  });

  it("does not restore a routed agent whose durable pin moved away from the heartbeat client", async () => {
    const app = getApp();
    const { agent, userId, organizationId, clientId } = await createTestAgent(app, {
      name: `cs-hb-pin-${crypto.randomUUID().slice(0, 6)}`,
    });
    const otherClientId = `client-hb-pin-other-${crypto.randomUUID().slice(0, 8)}`;

    await clientService.registerClient(app.db, { clientId, userId, organizationId, instanceId: "test" });
    await clientService.registerClient(app.db, {
      clientId: otherClientId,
      userId,
      organizationId,
      instanceId: "other-instance",
    });
    await presenceService.bindAgent(app.db, agent.uuid, { clientId, instanceId: "test", runtimeType: "test" });
    await app.db.update(agents).set({ clientId: otherClientId }).where(eq(agents.uuid, agent.uuid));
    await app.db
      .update(agentPresence)
      .set({ status: "offline", clientId: null, instanceId: null })
      .where(eq(agentPresence.agentId, agent.uuid));

    const result = await recordClientHeartbeat(app.db, {
      clientId,
      instanceId: "test",
      routedAgentIds: [agent.uuid],
    });

    expect(result).toEqual({ clientUpdated: true, restoredAgentIds: [] });

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("offline");
    expect(presence?.clientId).toBeNull();
    expect(presence?.instanceId).toBeNull();
  });

  it("does not revive a client or agent route when the client lease moved to another instance", async () => {
    const app = getApp();
    const { agent, userId, organizationId, clientId } = await createTestAgent(app, {
      name: `cs-hb-instance-${crypto.randomUUID().slice(0, 6)}`,
    });
    const newLastSeenAt = new Date();

    await clientService.registerClient(app.db, { clientId, userId, organizationId, instanceId: "old-instance" });
    await presenceService.bindAgent(app.db, agent.uuid, {
      clientId,
      instanceId: "old-instance",
      runtimeType: "test",
    });
    await app.db
      .update(clients)
      .set({ status: "connected", instanceId: "new-instance", lastSeenAt: newLastSeenAt })
      .where(eq(clients.id, clientId));
    await app.db
      .update(agentPresence)
      .set({ status: "offline", clientId: null, instanceId: null })
      .where(eq(agentPresence.agentId, agent.uuid));

    const result = await recordClientHeartbeat(app.db, {
      clientId,
      instanceId: "old-instance",
      routedAgentIds: [agent.uuid],
    });

    expect(result).toEqual({ clientUpdated: false, restoredAgentIds: [] });

    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(client?.status).toBe("connected");
    expect(client?.instanceId).toBe("new-instance");
    expect(client?.lastSeenAt.getTime()).toBe(newLastSeenAt.getTime());

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("offline");
    expect(presence?.clientId).toBeNull();
    expect(presence?.instanceId).toBeNull();
  });

  it("does not revive a retired client or routed agent", async () => {
    const app = getApp();
    const { agent, userId, organizationId, clientId } = await createTestAgent(app, {
      name: `cs-hb-retired-${crypto.randomUUID().slice(0, 6)}`,
    });
    const retiredAt = new Date();
    const lastSeenAt = new Date(retiredAt.getTime() - 1_000);

    await clientService.registerClient(app.db, { clientId, userId, organizationId, instanceId: "old-instance" });
    await presenceService.bindAgent(app.db, agent.uuid, {
      clientId,
      instanceId: "old-instance",
      runtimeType: "test",
    });
    await app.db
      .update(clients)
      .set({ status: "disconnected", instanceId: null, retiredAt, lastSeenAt })
      .where(eq(clients.id, clientId));
    await app.db
      .update(agentPresence)
      .set({ status: "offline", clientId: null, instanceId: null })
      .where(eq(agentPresence.agentId, agent.uuid));

    const result = await recordClientHeartbeat(app.db, {
      clientId,
      instanceId: "old-instance",
      routedAgentIds: [agent.uuid],
    });

    expect(result).toEqual({ clientUpdated: false, restoredAgentIds: [] });

    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(client?.status).toBe("disconnected");
    expect(client?.instanceId).toBeNull();
    expect(client?.retiredAt?.toISOString()).toBe(retiredAt.toISOString());
    expect(client?.lastSeenAt.toISOString()).toBe(lastSeenAt.toISOString());

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("offline");
    expect(presence?.clientId).toBeNull();
    expect(presence?.instanceId).toBeNull();
  });

  it("does not restore a routed agent that is no longer active", async () => {
    const app = getApp();
    const { agent, userId, organizationId, clientId } = await createTestAgent(app, {
      name: `cs-hb-status-${crypto.randomUUID().slice(0, 6)}`,
    });

    await clientService.registerClient(app.db, { clientId, userId, organizationId, instanceId: "test" });
    await presenceService.bindAgent(app.db, agent.uuid, { clientId, instanceId: "test", runtimeType: "test" });
    await suspendAgent(app.db, agent.uuid);
    await app.db
      .update(agentPresence)
      .set({ status: "offline", clientId: null, instanceId: null })
      .where(eq(agentPresence.agentId, agent.uuid));

    const result = await recordClientHeartbeat(app.db, {
      clientId,
      instanceId: "test",
      routedAgentIds: [agent.uuid],
    });

    expect(result).toEqual({ clientUpdated: true, restoredAgentIds: [] });

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agent.uuid));
    expect(presence?.status).toBe("offline");
    expect(presence?.clientId).toBeNull();
    expect(presence?.instanceId).toBeNull();
  });
});
