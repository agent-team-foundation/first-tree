import { describe, expect, it, vi } from "vitest";
import { upsertSessionState } from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import type { Notifier } from "../services/notifier.js";
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
      type: "group",
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

  // Predictive write may target an agent whose client has never bound (so
  // `agent_presence` has no row yet). The previous `update ... where agentId`
  // silently dropped the activeSessions/totalSessions refresh in that case;
  // the INSERT ... ON CONFLICT DO UPDATE form must populate the row instead.
  // See PR #198 review §2.
  it("creates the agent_presence row when none exists (predictive write on a never-bound agent)", async () => {
    const { app, admin, agent, chat } = await setup();
    // Do NOT seed presence.
    expect(await readPresence(app, agent.uuid)).toBeUndefined();

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, undefined, {
      touchPresenceLastSeen: false,
    });

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    expect(row?.activeSessions).toBe(1);
    expect(row?.totalSessions).toBe(1);
  });

  // Steady-state guard: when the (agent, chat) row is already at the target
  // state, a repeat upsert must NOT push a `session:state` NOTIFY and must
  // NOT churn `agent_presence.lastSeenAt` — otherwise the predictive Step 1b
  // in services/message.ts (called once per message) fans into N session:state
  // frames per N messages, which the admin WS then re-broadcasts into a
  // matching N invalidations of `["activity"]` / `["sessions"]` in every open
  // dashboard tab. The client's `heartbeat` frame remains the canonical
  // lastSeenAt path.
  it("does NOT NOTIFY or refresh lastSeenAt when state is unchanged", async () => {
    const { app, admin, agent, chat } = await setup();
    // Bring the row to `active` once so the second call is the no-op case.
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const firstSeen = (await readPresence(app, agent.uuid))?.lastSeenAt?.getTime();
    expect(firstSeen).toBeDefined();

    const notifier = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      notify: vi.fn(async () => {}),
      notifyConfigChange: vi.fn(async () => {}),
      notifySessionStateChange: vi.fn(async () => {}),
      notifyRuntimeStateChange: vi.fn(async () => {}),
      notifyChatMessage: vi.fn(async () => {}),
      notifySessionEvent: vi.fn(async () => {}),
      pushFrameToInbox: vi.fn(async () => 0),
      onConfigChange: vi.fn(),
      onSessionStateChange: vi.fn(),
      onSessionEvent: vi.fn(),
      onRuntimeStateChange: vi.fn(),
      onChatMessage: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } satisfies Notifier;

    // Wait a beat so a stray lastSeenAt write would be detectable.
    await new Promise((r) => setTimeout(r, 20));

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    const secondSeen = (await readPresence(app, agent.uuid))?.lastSeenAt?.getTime();
    expect(secondSeen).toBe(firstSeen);
  });

  // The complement of the previous test: a real state transition (active →
  // suspended) must still NOTIFY and still refresh presence. Guards against an
  // over-eager short-circuit that drops the wrong cases.
  it("DOES NOTIFY when state actually transitions", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);

    const notifier = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      notify: vi.fn(async () => {}),
      notifyConfigChange: vi.fn(async () => {}),
      notifySessionStateChange: vi.fn(async () => {}),
      notifyRuntimeStateChange: vi.fn(async () => {}),
      notifyChatMessage: vi.fn(async () => {}),
      notifySessionEvent: vi.fn(async () => {}),
      pushFrameToInbox: vi.fn(async () => 0),
      onConfigChange: vi.fn(),
      onSessionStateChange: vi.fn(),
      onSessionEvent: vi.fn(),
      onRuntimeStateChange: vi.fn(),
      onChatMessage: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } satisfies Notifier;

    await upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId, notifier);

    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionStateChange).toHaveBeenCalledWith(
      agent.uuid,
      chat.id,
      "suspended",
      admin.organizationId,
    );
  });
});
