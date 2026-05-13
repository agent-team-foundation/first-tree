import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { notifications } from "../db/schema/notifications.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as notificationService from "../services/notification.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * Fault-scoped notification de-duplication + auto-resolve.
 *
 * Two behaviours nail down the contract:
 *
 *   1. All three fault types (`agent_error`, `agent_blocked`, `agent_stale`)
 *      share one dedup key (`agent:{id}:fault`). The bell must show one
 *      unread row for a misbehaving agent, not three — same incident
 *      surfaced through different observation channels.
 *   2. `markAgentFaultsResolved` closes every unread row for the agent.
 *      Called when the agent rebinds (offline → online) or reports a
 *      healthy runtime state (error/blocked → idle/working) — without this
 *      the bell badge lingers across the recovery.
 */
describe("Notification — fault dedup + auto-resolve", () => {
  let app: FastifyInstance;
  let orgId: string;

  async function seedAgent(suffix: string) {
    const userId = uuidv7();
    const memberId = uuidv7();
    return app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `fault-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `Fault User ${suffix}`,
      });
      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `fault-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `Fault Human ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });
      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: humanAgent.uuid,
        role: "admin",
      });
      const agent = await createAgent(tx as unknown as typeof app.db, {
        name: `fault-agent-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: `Fault Agent ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });
      return { agent, memberId };
    });
  }

  async function unreadFor(agentId: string) {
    return app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.agentId, agentId), eq(notifications.read, false)));
  }

  beforeAll(async () => {
    app = await createTestApp();
    orgId = await resolveDefaultOrgId(app.db);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("collapses agent_error + agent_blocked + agent_stale into one unread row per agent", async () => {
    const { agent } = await seedAgent("dedup");

    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_error", "high");
    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_blocked", "medium");
    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_stale", "medium");

    const open = await unreadFor(agent.uuid);
    expect(open).toHaveLength(1);
    // The first event wins (ON CONFLICT DO NOTHING). It doesn't matter
    // *which* type holds the slot — the contract is "one row, not three".
    expect(["agent_error", "agent_blocked", "agent_stale"]).toContain(open[0]?.type);
  });

  it("lets a new fault fire after the prior row is marked read", async () => {
    const { agent } = await seedAgent("reopen");

    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_error", "high");
    expect(await unreadFor(agent.uuid)).toHaveLength(1);

    // Simulate recovery — mark the row read, then a fresh fault should not
    // be suppressed by the partial unique index (which only covers unread
    // rows).
    await notificationService.markAgentFaultsResolved(app.db, agent.uuid);
    expect(await unreadFor(agent.uuid)).toHaveLength(0);

    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_blocked", "medium");
    const reopened = await unreadFor(agent.uuid);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.type).toBe("agent_blocked");
  });

  it("markAgentFaultsResolved closes every unread row, leaves other agents' rows alone", async () => {
    const a = await seedAgent("close-a");
    const b = await seedAgent("close-b");

    await notificationService.notifyAgentEvent(app.db, a.agent.uuid, "agent_error", "high");
    await notificationService.notifyAgentEvent(app.db, b.agent.uuid, "agent_error", "high");

    expect(await unreadFor(a.agent.uuid)).toHaveLength(1);
    expect(await unreadFor(b.agent.uuid)).toHaveLength(1);

    await notificationService.markAgentFaultsResolved(app.db, a.agent.uuid);

    expect(await unreadFor(a.agent.uuid)).toHaveLength(0);
    // B's row stays open — resolve is scoped to the agent that recovered.
    expect(await unreadFor(b.agent.uuid)).toHaveLength(1);
  });
});
