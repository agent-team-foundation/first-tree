import { describe, expect, it } from "vitest";
import { upsertSessionState } from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { createAdminContext, useTestApp } from "./helpers.js";
import { readPresence, seedPresence } from "./session-state-helpers.js";

describe("upsertSessionState — touchPresenceLastSeen option", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `up-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `up-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Upsert target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "direct",
      participantIds: [agent.uuid],
    });
    return { app, admin, agent, chat };
  }

  it("default behavior touches lastSeenAt to now", async () => {
    const { app, admin, agent, chat } = await setup();
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, agent.uuid, oldDate);

    const before = Date.now();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const after = Date.now();

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    const ts = row?.lastSeenAt?.getTime() ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before - 50);
    expect(ts).toBeLessThanOrEqual(after + 50);
  });

  it("touchPresenceLastSeen=false keeps lastSeenAt unchanged but still updates active/total counts", async () => {
    const { app, admin, agent, chat } = await setup();
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, agent.uuid, oldDate);

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, undefined, {
      touchPresenceLastSeen: false,
    });

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    expect(row?.lastSeenAt?.getTime()).toBe(oldDate.getTime());
    expect(row?.activeSessions).toBe(1);
    expect(row?.totalSessions).toBe(1);
  });

  it("touchPresenceLastSeen=true (explicit) behaves as default", async () => {
    const { app, admin, agent, chat } = await setup();
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, agent.uuid, oldDate);

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, undefined, {
      touchPresenceLastSeen: true,
    });

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    expect(row?.lastSeenAt?.getTime()).toBeGreaterThan(oldDate.getTime());
  });
});
