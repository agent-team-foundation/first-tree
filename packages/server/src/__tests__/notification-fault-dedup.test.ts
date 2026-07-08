import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { notifications } from "../db/schema/notifications.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as notificationService from "../services/notification.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

const DEFAULT_TEST_ORG_ID = "01961234-0000-7000-8000-000000000000";

/**
 * Fault-scoped notification de-duplication + auto-resolve.
 *
 * Four behaviours nail down the contract:
 *
 *   1. All three fault types (`agent_error`, `agent_blocked`, `agent_stale`)
 *      share one dedup key (`agent:{id}:fault`). The bell must show one
 *      unread row for a misbehaving agent, not three — same incident
 *      surfaced through different observation channels.
 *   2. The dedup row's **severity escalates monotonically** and its
 *      **type / message take the latest event's values**. A stale=medium
 *      observation must not mask a subsequent error=high observation just
 *      because it arrived first.
 *   3. `markAgentFaultsResolved` closes only fault-scoped rows for the
 *      agent. A non-fault agent-scoped notification (e.g. a future
 *      reminder) MUST NOT silently flip to read when the agent rebinds.
 *   4. Resolve is per-agent — recovering agent A does not touch agent B.
 */
describe("Notification — fault dedup + auto-resolve", () => {
  let app: FastifyInstance;
  let orgId: string;

  async function seedAgent(suffix: string, options: { clientHostname?: string } = {}) {
    const userId = uuidv7();
    const memberId = uuidv7();
    return app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `fault-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `Fault User ${suffix}`,
      });
      const clientId = options.clientHostname ? `fault-client-${suffix}-${crypto.randomUUID().slice(0, 6)}` : null;
      if (clientId) {
        await tx.insert(clients).values({
          id: clientId,
          userId,
          organizationId: orgId,
          status: "connected",
          hostname: options.clientHostname,
        });
      }
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
        type: "agent",
        displayName: `Fault Agent ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
        ...(clientId ? { clientId } : {}),
      });
      return { agent, memberId, userId, clientId };
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
    orgId = DEFAULT_TEST_ORG_ID;
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
  });

  it("escalates severity monotonically and lets the latest event win type + message", async () => {
    const { agent } = await seedAgent("escalate");

    // Open the incident with the lowest severity / oldest fact about the
    // agent — heartbeat-stale (medium).
    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_stale", "medium");
    const [afterStale] = await unreadFor(agent.uuid);
    expect(afterStale?.severity).toBe("medium");
    expect(afterStale?.type).toBe("agent_stale");
    const staleMessage = afterStale?.message;
    const staleCreatedAt = afterStale?.createdAt;

    // Runtime then reports an actual error — severity should jump to high,
    // and the row's type + message should reflect the newer observation.
    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_error", "high");
    const [afterError] = await unreadFor(agent.uuid);
    expect(afterError?.severity).toBe("high");
    expect(afterError?.type).toBe("agent_error");
    expect(afterError?.message).not.toBe(staleMessage);
    // createdAt is preserved so the bell ordering still tracks "when did
    // this incident open" rather than "when was the last observation".
    expect(afterError?.createdAt.getTime()).toBe(staleCreatedAt?.getTime());

    // A lower-severity event arriving after the high mark must NOT downgrade.
    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_blocked", "medium");
    const [afterBlocked] = await unreadFor(agent.uuid);
    expect(afterBlocked?.severity).toBe("high");
    // Type and message still take the latest event's values.
    expect(afterBlocked?.type).toBe("agent_blocked");
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

  it("markAgentFaultsResolved closes every unread fault row, leaves other agents' rows alone", async () => {
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

  it("markAgentFaultsResolved does NOT touch non-fault agent-scoped rows", async () => {
    // Forward-compat check. The current schema only has fault types, so we
    // simulate a hypothetical future row by inserting directly — bypassing
    // notifyAgentEvent's NotificationType enum gate but using a value the
    // notifications.type text column accepts. If someone adds a per-agent
    // reminder / system message in the future, this guard catches the
    // first PR that wires it through `mark-resolved` without re-deriving
    // the type allow-list.
    const { agent } = await seedAgent("scoped");

    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_error", "high");

    // Simulate a non-fault agent-scoped type by going through the table
    // unsafely — `notifications.type` is a plain text column, the enum
    // gate lives in the shared Zod schema and `notifyAgentEvent`'s API.
    await app.db.execute(sql`
      INSERT INTO notifications (id, organization_id, type, severity, agent_id, message)
      VALUES (${uuidv7()}, ${orgId}, 'agent_reminder', 'low', ${agent.uuid},
              'Friendly reminder from a feature we have not built yet')
    `);
    expect(await unreadFor(agent.uuid)).toHaveLength(2);

    await notificationService.markAgentFaultsResolved(app.db, agent.uuid);

    const remaining = await unreadFor(agent.uuid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe("agent_reminder");
  });

  it("uses client hostname for stale-agent messages and supports explicit no-dedup notifications", async () => {
    const { agent } = await seedAgent("client-label", { clientHostname: "build-host-17" });

    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_stale", "medium", { dedupKey: null });
    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_stale", "medium", { dedupKey: null });

    const open = await unreadFor(agent.uuid);
    expect(open).toHaveLength(2);
    expect(open[0]?.message).toBe("Computer build-host-17 is unresponsive");
  });

  it("falls back to default notification copy for future agent event types", async () => {
    const { agent } = await seedAgent("future-type");

    await notificationService.notifyAgentEvent(app.db, agent.uuid, "agent_future" as never, "low");

    const [open] = await unreadFor(agent.uuid);
    expect(open?.type).toBe("agent_future");
    expect(open?.message).toBe(`${agent.displayName} event`);
  });

  it("swallows notification service failures and webhook delivery failures", async () => {
    const originalWebhook = process.env.FIRST_TREE_NOTIFICATION_WEBHOOK_URL;
    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[] = [];
    process.env.FIRST_TREE_NOTIFICATION_WEBHOOK_URL = "https://example.invalid/notify";
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls.push(input);
      throw new Error("webhook down");
    }) as typeof fetch;
    try {
      await expect(
        notificationService.notifyAgentEvent(
          {
            select: () => {
              throw new Error("select failed");
            },
          } as never,
          "missing-agent",
          "agent_error",
          "high",
        ),
      ).resolves.toBeUndefined();
      await expect(
        notificationService.markAgentFaultsResolved(
          {
            update: () => {
              throw new Error("update failed");
            },
          } as never,
          "agent-a",
        ),
      ).resolves.toBeUndefined();

      const insertedAt = new Date();
      const fakeDb = {
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [
                {
                  id: "notification-a",
                  organizationId: orgId,
                  type: "agent_error",
                  severity: "high",
                  agentId: "agent-a",
                  chatId: null,
                  message: "boom",
                  read: false,
                  createdAt: insertedAt,
                },
              ],
            }),
          }),
        }),
      };
      await expect(
        notificationService.createNotification(fakeDb as never, {
          organizationId: orgId,
          type: "agent_error",
          severity: "high",
          agentId: "agent-a",
          message: "boom",
        }),
      ).resolves.toMatchObject({ id: "notification-a", createdAt: insertedAt.toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchCalls).toEqual(["https://example.invalid/notify"]);

      const emptyReturningDb = {
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [],
            }),
          }),
        }),
      };
      await expect(
        notificationService.createNotification(emptyReturningDb as never, {
          organizationId: orgId,
          type: "agent_error",
          severity: "high",
          message: "suppressed",
        }),
      ).resolves.toBeNull();
    } finally {
      if (originalWebhook === undefined) {
        delete process.env.FIRST_TREE_NOTIFICATION_WEBHOOK_URL;
      } else {
        process.env.FIRST_TREE_NOTIFICATION_WEBHOOK_URL = originalWebhook;
      }
      globalThis.fetch = originalFetch;
    }
  });
});
