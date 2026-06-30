import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { agents as agentsTable } from "../db/schema/agents.js";
import { members as membersTable } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { retireClient } from "../services/client.js";
import { createMember } from "../services/member.js";
import { leaveOrganization } from "../services/membership.js";
import { createOrganization } from "../services/organization.js";
import { seedClient, useTestApp } from "./helpers.js";

/**
 * Issue #1353: self-service leave must align with admin member removal for the
 * non-human agents the leaving member manages — otherwise those agents stay
 * `active` and pinned to the user's client, and `retireClient`'s guard
 * deadlocks the user out of retiring their own computer.
 */
describe("self-service leave: managed non-human agents", () => {
  const getApp = useTestApp();

  async function freshOrg(prefix: string) {
    return createOrganization(getApp().db, {
      name: `${prefix}-${randomUUID().slice(0, 8)}`,
      displayName: "Leave Test Org",
    });
  }

  it("transfers managed agents to a fallback admin, clears clientId, and unblocks retiring the client", async () => {
    const app = getApp();
    const org = await freshOrg("leave-transfer");
    const fallbackAdmin = await createMember(app.db, org.id, {
      username: `fb-${randomUUID().slice(0, 8)}`,
      displayName: "Fallback Admin",
      role: "admin",
    });
    const leaver = await createMember(app.db, org.id, {
      username: `lv-${randomUUID().slice(0, 8)}`,
      displayName: "Leaver",
      role: "admin",
    });

    const clientId = await seedClient(app, leaver.userId, org.id);
    const managed = await createAgent(app.db, {
      name: `managed-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Managed Agent",
      managerId: leaver.id,
      clientId,
    });

    // Precondition: while the agent is active and pinned, retire is blocked.
    await expect(retireClient(app.db, clientId)).rejects.toThrow(/still pinned/i);

    await leaveOrganization(app.db, leaver.id);

    // Managed agent moved to the fallback admin and unpinned.
    const [managedRow] = await app.db
      .select({ managerId: agentsTable.managerId, clientId: agentsTable.clientId, status: agentsTable.status })
      .from(agentsTable)
      .where(eq(agentsTable.uuid, managed.uuid))
      .limit(1);
    expect(managedRow?.managerId).toBe(fallbackAdmin.id);
    expect(managedRow?.clientId).toBeNull();
    expect(managedRow?.status).toBe("active");

    // Leaver's membership is left; human mirror suspended, named, unpinned.
    const [memberRow] = await app.db
      .select({ status: membersTable.status })
      .from(membersTable)
      .where(eq(membersTable.id, leaver.id))
      .limit(1);
    expect(memberRow?.status).toBe("left");
    const [mirror] = await app.db
      .select({ status: agentsTable.status, name: agentsTable.name, clientId: agentsTable.clientId })
      .from(agentsTable)
      .where(eq(agentsTable.uuid, leaver.agentId))
      .limit(1);
    expect(mirror?.status).toBe("suspended");
    expect(mirror?.name).not.toBeNull();
    expect(mirror?.clientId).toBeNull();

    // The client can now be retired.
    await expect(retireClient(app.db, clientId)).resolves.toBeUndefined();
  });

  it("blocks leave when the member manages agents and no other active admin exists", async () => {
    const app = getApp();
    const org = await freshOrg("leave-noadmin");
    const soleAdmin = await createMember(app.db, org.id, {
      username: `solo-${randomUUID().slice(0, 8)}`,
      displayName: "Sole Admin",
      role: "admin",
    });
    const clientId = await seedClient(app, soleAdmin.userId, org.id);
    const managed = await createAgent(app.db, {
      name: `managed-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Managed Agent",
      managerId: soleAdmin.id,
      clientId,
    });

    await expect(leaveOrganization(app.db, soleAdmin.id)).rejects.toThrow(/another admin|no other active admin/i);

    // Nothing changed: agent still managed + pinned, membership still active.
    const [managedRow] = await app.db
      .select({ managerId: agentsTable.managerId, clientId: agentsTable.clientId })
      .from(agentsTable)
      .where(eq(agentsTable.uuid, managed.uuid))
      .limit(1);
    expect(managedRow?.managerId).toBe(soleAdmin.id);
    expect(managedRow?.clientId).toBe(clientId);
    const [memberRow] = await app.db
      .select({ status: membersTable.status })
      .from(membersTable)
      .where(eq(membersTable.id, soleAdmin.id))
      .limit(1);
    expect(memberRow?.status).toBe("active");
  });

  it("lets a sole admin leave after deleting their only non-human agent (tombstones do not block)", async () => {
    const app = getApp();
    const org = await freshOrg("leave-tombstone");
    const soleAdmin = await createMember(app.db, org.id, {
      username: `tomb-${randomUUID().slice(0, 8)}`,
      displayName: "Sole Admin",
      role: "admin",
    });
    const clientId = await seedClient(app, soleAdmin.userId, org.id);
    const managed = await createAgent(app.db, {
      name: `managed-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Managed Agent",
      managerId: soleAdmin.id,
      clientId,
    });
    // The user follows the no-fallback-admin 409's guidance and deletes the
    // agent. deleteAgent only tombstones (status='deleted', managerId intact),
    // and retireClient already ignores deleted agents — so leave must stop
    // counting it, otherwise the sole admin is trapped forever.
    await app.db.update(agentsTable).set({ status: "deleted", name: null }).where(eq(agentsTable.uuid, managed.uuid));

    await leaveOrganization(app.db, soleAdmin.id);

    const [memberRow] = await app.db
      .select({ status: membersTable.status })
      .from(membersTable)
      .where(eq(membersTable.id, soleAdmin.id))
      .limit(1);
    expect(memberRow?.status).toBe("left");
    // The tombstone is left untouched — not reassigned to a (nonexistent) admin.
    const [managedRow] = await app.db
      .select({ managerId: agentsTable.managerId, status: agentsTable.status })
      .from(agentsTable)
      .where(eq(agentsTable.uuid, managed.uuid))
      .limit(1);
    expect(managedRow?.status).toBe("deleted");
    expect(managedRow?.managerId).toBe(soleAdmin.id);
  });

  it("allows a sole admin with no managed agents to leave (narrow scope), suspending the human mirror", async () => {
    const app = getApp();
    const org = await freshOrg("leave-empty");
    const soleAdmin = await createMember(app.db, org.id, {
      username: `empty-${randomUUID().slice(0, 8)}`,
      displayName: "Sole Admin No Agents",
      role: "admin",
    });

    await leaveOrganization(app.db, soleAdmin.id);

    const [memberRow] = await app.db
      .select({ status: membersTable.status })
      .from(membersTable)
      .where(eq(membersTable.id, soleAdmin.id))
      .limit(1);
    expect(memberRow?.status).toBe("left");
    const [mirror] = await app.db
      .select({ status: agentsTable.status, name: agentsTable.name, clientId: agentsTable.clientId })
      .from(agentsTable)
      .where(eq(agentsTable.uuid, soleAdmin.agentId))
      .limit(1);
    expect(mirror?.status).toBe("suspended");
    expect(mirror?.name).not.toBeNull();
    expect(mirror?.clientId).toBeNull();
  });

  it("does not strand an agent created concurrently with the manager's departure", async () => {
    const app = getApp();
    const org = await freshOrg("leave-race");
    // A fallback admin exists so the leaver is not the sole admin — this test
    // is about the create/leave race, not the no-fallback block.
    await createMember(app.db, org.id, {
      username: `race-fb-${randomUUID().slice(0, 8)}`,
      displayName: "Fallback Admin",
      role: "admin",
    });
    const leaver = await createMember(app.db, org.id, {
      username: `race-lv-${randomUUID().slice(0, 8)}`,
      displayName: "Leaver",
      role: "admin",
    });

    // Raw second connection holds an *uncommitted* `status = 'left'` update on
    // the leaver, taking the same member row lock that `deactivateMembership`
    // would. createAgent's pre-transaction check still reads the committed
    // `active` state, but its in-transaction `FOR UPDATE` re-check blocks on
    // this lock; once we commit, the re-check sees the member is no longer
    // active and aborts. Without the in-transaction re-check, the agent insert
    // would block on the FK lock and then succeed once we commit — stranding an
    // `active` agent on a departed manager. The outcome here is driven by the
    // lock, not by sleep timing, so it is deterministic.
    const raw = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    try {
      await raw`BEGIN`;
      await raw`UPDATE members SET status = 'left' WHERE id = ${leaver.id}`;

      const createOutcome = createAgent(app.db, {
        name: `raced-${randomUUID().slice(0, 8)}`,
        type: "agent",
        displayName: "Raced Agent",
        managerId: leaver.id,
      })
        .then(() => "created" as const)
        .catch((err: unknown) => err);

      // Give createAgent a moment to reach (and block on) the FOR UPDATE.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await raw`COMMIT`;

      const outcome = await createOutcome;
      expect(outcome).not.toBe("created");
      expect((outcome as Error)?.message ?? "").toMatch(/not found/i);

      // No non-human agent was stranded on the departed manager.
      const stranded = await app.db
        .select({ uuid: agentsTable.uuid })
        .from(agentsTable)
        .where(and(eq(agentsTable.managerId, leaver.id), ne(agentsTable.type, "human")));
      expect(stranded).toHaveLength(0);
    } finally {
      await raw.end();
    }
  });
});
