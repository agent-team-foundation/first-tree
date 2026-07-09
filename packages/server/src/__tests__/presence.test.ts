import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import * as presenceService from "../services/presence.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Presence Service", () => {
  const getApp = useTestApp();

  it("sets agent online and offline", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: "pres-a1" });

    // Set online
    await presenceService.setOnline(app.db, agent.uuid, "test-instance");
    let presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("online");
    expect(presence?.instanceId).toBe("test-instance");

    // Set offline
    await presenceService.setOffline(app.db, agent.uuid);
    presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.status).toBe("offline");
    expect(presence?.instanceId).toBeNull();
  });

  it("counts online agents", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: "count-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "count-a2" });

    await presenceService.setOnline(app.db, a1.uuid, "inst-1");
    await presenceService.setOnline(app.db, a2.uuid, "inst-1");

    const count = await presenceService.getOnlineCount(app.db);
    expect(count).toBe(2);

    await presenceService.setOffline(app.db, a1.uuid);
    const count2 = await presenceService.getOnlineCount(app.db);
    expect(count2).toBe(1);
  });

  it("upserts presence on repeated setOnline", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: "upsert-a1" });

    await presenceService.setOnline(app.db, agent.uuid, "inst-1");
    await presenceService.setOnline(app.db, agent.uuid, "inst-2");

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.instanceId).toBe("inst-2");
  });

  it("returns null for agent without presence record", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: "nopres-a1" });

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence).toBeNull();
  });

  it("heartbeats server instance", async () => {
    const app = getApp();

    // Should not throw
    await presenceService.heartbeatInstance(app.db, "test-heartbeat-instance");
    await presenceService.heartbeatInstance(app.db, "test-heartbeat-instance");
  });

  it("touches per-agent liveness without changing presence status", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: "touch-a1" });
    await presenceService.setOnline(app.db, agent.uuid, "touch-instance");
    await app.db
      .update(agentPresence)
      .set({ lastSeenAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(agentPresence.agentId, agent.uuid));

    await presenceService.touchAgent(app.db, agent.uuid);

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.status).toBe("online");
    expect(presence?.lastSeenAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00.000Z").getTime());
  });

  it("marks stale agents offline by per-agent heartbeat age", async () => {
    const app = getApp();
    const { agent, clientId } = await createTestAgent(app, { name: "stale-agent-a1" });
    await presenceService.setOnline(app.db, agent.uuid, "stale-agent-instance");
    await app.db.execute(sql`
      UPDATE agent_presence
         SET last_seen_at = NOW() - INTERVAL '120 seconds',
             client_id = ${clientId},
             runtime_state = 'working',
             active_sessions = 1,
             total_sessions = 2
       WHERE agent_id = ${agent.uuid}
    `);

    const staleAgentIds = await presenceService.markStaleAgents(app.db, 60);

    expect(staleAgentIds).toEqual([agent.uuid]);
    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence).toMatchObject({
      status: "offline",
      clientId: null,
      runtimeState: null,
      activeSessions: null,
      totalSessions: null,
    });
  });

  it("cleans up stale presence", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: "stale-a1" });

    // Set online with a stale instance
    await presenceService.setOnline(app.db, agent.uuid, "stale-instance");

    // Register stale instance with old heartbeat
    await app.db.execute(sql`
      INSERT INTO server_instances (instance_id, last_heartbeat)
      VALUES ('stale-instance', NOW() - INTERVAL '120 seconds')
      ON CONFLICT (instance_id) DO UPDATE SET last_heartbeat = NOW() - INTERVAL '120 seconds'
    `);

    // Cleanup with 60-second threshold
    const cleaned = await presenceService.cleanupStalePresence(app.db, 60);
    expect(cleaned).toBe(1);

    const presence = await presenceService.getPresence(app.db, agent.uuid);
    expect(presence?.status).toBe("offline");
  });
});
