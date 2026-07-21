import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { agents as agentsTable } from "../db/schema/agents.js";
import { members as membersTable } from "../db/schema/members.js";
import { organizations as organizationsTable } from "../db/schema/organizations.js";
import { users as usersTable } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as memberService from "../services/member.js";
import { ensureMembership, repairMembershipHumanMirrors, selfCreateOrganization } from "../services/membership.js";
import { createOrganization } from "../services/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForPostgresLockWait(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

describe("Members API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const admin = await createTestAdmin(app, { username: `member-admin-${Date.now()}` });
    const orgId = admin.organizationId;
    const req = (method: string, url: string, payload?: Record<string, unknown>) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url: url.replace("/api/v1/members", `/api/v1/orgs/${orgId}/members`),
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload,
      });
    return req;
  }

  async function createOtherOrgTargetMember(app: FastifyInstance, prefix: string) {
    const otherOrg = await createOrganization(app.db, {
      name: `${prefix}-${randomUUID().slice(0, 8)}`,
      displayName: "IDOR Target",
    });
    await memberService.createMember(app.db, otherOrg.id, {
      username: `${prefix}-owner-${randomUUID().slice(0, 8)}`,
      displayName: "Other Org Admin",
      role: "admin",
    });
    const target = await memberService.createMember(app.db, otherOrg.id, {
      username: `${prefix}-target-${randomUUID().slice(0, 8)}`,
      displayName: "Other Org Member",
      role: "member",
    });
    return { otherOrg, target };
  }

  async function attachExistingUserToOtherOrg(
    app: FastifyInstance,
    input: { userId: string; displayName: string; prefix: string },
  ) {
    const organization = await createOrganization(app.db, {
      name: `${input.prefix}-${randomUUID().slice(0, 8)}`,
      displayName: "Identity Side",
    });
    const memberId = randomUUID();
    let agentId = "";
    await app.db.transaction(async (tx) => {
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `${input.prefix}-human-${randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: input.displayName,
        managerId: memberId,
        organizationId: organization.id,
      });
      agentId = human.uuid;
      await tx.insert(membersTable).values({
        id: memberId,
        userId: input.userId,
        organizationId: organization.id,
        agentId,
        role: "member",
      });
    });
    return { organizationId: organization.id, memberId, agentId };
  }

  describe("GET /api/v1/members", () => {
    it("lists members (at least the admin who created them)", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const res = await req("GET", "/api/v1/members");
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ id: string; username: string; role: string; avatarUrl: string | null }>>();
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty("username");
      expect(body[0]).toHaveProperty("role");
      expect(body[0]).toHaveProperty("agentId");
      expect(body[0]).toHaveProperty("avatarUrl");
    });

    it("returns a member's user avatar URL when present", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const createRes = await req("POST", "/api/v1/members", {
        username: `avatar-member-${Date.now()}`,
        displayName: "Avatar Member",
        role: "member",
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json<{ userId: string }>();
      const avatarUrl = "https://avatars.example.test/u/avatar-member.png";
      await app.db.update(usersTable).set({ avatarUrl }).where(eq(usersTable.id, created.userId));

      const res = await req("GET", "/api/v1/members");
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ userId: string; avatarUrl: string | null }>>();
      expect(body.find((member) => member.userId === created.userId)?.avatarUrl).toBe(avatarUrl);
    });
  });

  describe("POST /api/v1/members", () => {
    it("creates a member and returns one-time password", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const res = await req("POST", "/api/v1/members", {
        username: `newuser-${Date.now()}`,
        displayName: "New User",
        role: "member",
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{
        id: string;
        username: string;
        password: string;
        role: string;
        agentId: string;
        avatarUrl: string | null;
      }>();
      expect(body.password).toBeDefined();
      expect(body.password.length).toBeGreaterThan(0);
      expect(body.role).toBe("member");
      expect(body.agentId).toBeDefined();
      expect(body.avatarUrl).toBeNull();
    });

    it("rejects duplicate username in same org", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const username = `dup-${Date.now()}`;
      await req("POST", "/api/v1/members", { username, displayName: "First", role: "member" });
      const res = await req("POST", "/api/v1/members", { username, displayName: "Second", role: "member" });
      expect(res.statusCode).toBe(409);
    });

    it("created member can log in with generated password", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const username = `login-test-${Date.now()}`;
      const createRes = await req("POST", "/api/v1/members", {
        username,
        displayName: "Login Tester",
        role: "member",
      });
      const { password } = createRes.json<{ password: string }>();

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.json()).toHaveProperty("accessToken");
    });
  });

  describe("PATCH /api/v1/members/:id", () => {
    it("updates member role", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const createRes = await req("POST", "/api/v1/members", {
        username: `patch-${Date.now()}`,
        displayName: "Patchable",
        role: "member",
      });
      const { id } = createRes.json<{ id: string }>();

      const patchRes = await req("PATCH", `/api/v1/members/${id}`, { role: "admin" });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json<{ role: string }>().role).toBe("admin");
    });

    it("returns 404 for an empty patch against a member from another org", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `patch-idor-admin-${randomUUID().slice(0, 8)}` });
      const { target } = await createOtherOrgTargetMember(app, "patch-idor");

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${admin.organizationId}/members/${target.id}`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {},
      });
      expect(patchRes.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/v1/members/:id", () => {
    it("removes member, suspends their human mirror, and transfers managed agents", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const createRes = await req("POST", "/api/v1/members", {
        username: `delete-${Date.now()}`,
        displayName: "Deletable",
        role: "member",
      });
      const { id, agentId } = createRes.json<{ id: string; agentId: string }>();

      const managed = await createAgent(app.db, {
        name: `member-owned-${randomUUID().slice(0, 8)}`,
        type: "agent",
        managerId: id,
      });

      const deleteRes = await req("DELETE", `/api/v1/members/${id}`);
      expect(deleteRes.statusCode).toBe(204);

      const listRes = await req("GET", "/api/v1/members");
      const members = listRes.json<Array<{ id: string }>>();
      expect(members.find((m: { id: string }) => m.id === id)).toBeUndefined();

      const [memberRow] = await app.db
        .select({ status: membersTable.status })
        .from(membersTable)
        .where(eq(membersTable.id, id))
        .limit(1);
      expect(memberRow?.status).toBe("removed");

      const [humanMirror] = await app.db
        .select({ status: agentsTable.status, name: agentsTable.name })
        .from(agentsTable)
        .where(eq(agentsTable.uuid, agentId))
        .limit(1);
      expect(humanMirror?.status).toBe("suspended");
      expect(humanMirror?.name).not.toBeNull();

      const [managedRow] = await app.db
        .select({ managerId: agentsTable.managerId, clientId: agentsTable.clientId })
        .from(agentsTable)
        .where(eq(agentsTable.uuid, managed.uuid))
        .limit(1);
      expect(managedRow?.managerId).not.toBe(id);
      expect(managedRow?.clientId).toBeNull();
    });

    it("serializes concurrent admin removals so one active admin remains", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `race-admin-a-${randomUUID().slice(0, 8)}` });
      const createSecond = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/members`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {
          username: `race-admin-b-${randomUUID().slice(0, 8)}`,
          displayName: "Race Admin B",
          role: "admin",
        },
      });
      expect(createSecond.statusCode).toBe(201);
      const second = createSecond.json<{ id: string; username: string; password: string }>();
      const secondLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: second.username, password: second.password },
      });
      const secondAccessToken = secondLogin.json<{ accessToken: string }>().accessToken;

      const [deleteSecond, deleteFirst] = await Promise.all([
        app.inject({
          method: "DELETE",
          url: `/api/v1/orgs/${admin.organizationId}/members/${second.id}`,
          headers: { authorization: `Bearer ${admin.accessToken}` },
        }),
        app.inject({
          method: "DELETE",
          url: `/api/v1/orgs/${admin.organizationId}/members/${admin.memberId}`,
          headers: { authorization: `Bearer ${secondAccessToken}` },
        }),
      ]);

      const statusCodes = [deleteSecond.statusCode, deleteFirst.statusCode];
      expect(statusCodes.filter((status) => status === 204)).toHaveLength(1);

      const activeAdmins = await app.db
        .select({ id: membersTable.id })
        .from(membersTable)
        .where(
          and(
            eq(membersTable.organizationId, admin.organizationId),
            eq(membersTable.role, "admin"),
            eq(membersTable.status, "active"),
          ),
        );
      expect(activeAdmins).toHaveLength(1);
    });

    it("admin create restores a removed membership and the same human mirror", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const username = `restore-${Date.now()}`;
      const createRes = await req("POST", "/api/v1/members", {
        username,
        displayName: "Removable",
        role: "member",
      });
      const created = createRes.json<{ id: string; agentId: string }>();
      await req("DELETE", `/api/v1/members/${created.id}`);

      const restoreRes = await req("POST", "/api/v1/members", {
        username,
        displayName: "Restored",
        role: "admin",
      });
      expect(restoreRes.statusCode).toBe(201);
      const restored = restoreRes.json<{ id: string; agentId: string; role: string; notice: string }>();
      expect(restored.id).toBe(created.id);
      expect(restored.agentId).toBe(created.agentId);
      expect(restored.role).toBe("admin");
      expect(restored.notice).toMatch(/Existing user/);

      const [row] = await app.db
        .select({ status: membersTable.status, role: membersTable.role })
        .from(membersTable)
        .where(eq(membersTable.id, created.id))
        .limit(1);
      expect(row).toEqual({ status: "active", role: "admin" });

      const [mirror] = await app.db
        .select({ status: agentsTable.status, displayName: agentsTable.displayName, name: agentsTable.name })
        .from(agentsTable)
        .where(eq(agentsTable.uuid, created.agentId))
        .limit(1);
      expect(mirror?.status).toBe("active");
      expect(mirror?.displayName).toBe("Restored");
      expect(mirror?.name).not.toBeNull();
    });

    it("repairs pre-existing corrupted human mirrors for active and inactive memberships", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `repair-active-${randomUUID().slice(0, 8)}` });
      const req = (method: string, url: string, payload?: Record<string, unknown>) =>
        app.inject({
          method: method as "GET" | "POST" | "PATCH" | "DELETE",
          url: url.replace("/api/v1/members", `/api/v1/orgs/${admin.organizationId}/members`),
          headers: { authorization: `Bearer ${admin.accessToken}` },
          payload,
        });

      const leftRes = await req("POST", "/api/v1/members", {
        username: `repair-left-${randomUUID().slice(0, 8)}`,
        displayName: "Repair Left",
        role: "member",
      });
      const left = leftRes.json<{ id: string; agentId: string }>();
      const removedRes = await req("POST", "/api/v1/members", {
        username: `repair-removed-${randomUUID().slice(0, 8)}`,
        displayName: "Repair Removed",
        role: "member",
      });
      const removed = removedRes.json<{ id: string; agentId: string }>();
      await app.db.update(membersTable).set({ status: "left" }).where(eq(membersTable.id, left.id));
      await req("DELETE", `/api/v1/members/${removed.id}`);

      const [leftBefore] = await app.db
        .select({ name: agentsTable.name })
        .from(agentsTable)
        .where(eq(agentsTable.uuid, left.agentId))
        .limit(1);
      expect(leftBefore?.name).not.toBeNull();

      await app.db
        .update(agentsTable)
        .set({ type: "agent", status: "deleted", name: null, displayName: "Drifted Human", clientId: null })
        .where(eq(agentsTable.uuid, admin.humanAgentUuid));
      await app.db.update(agentsTable).set({ status: "active" }).where(eq(agentsTable.uuid, left.agentId));
      await app.db
        .update(agentsTable)
        .set({ type: "agent", status: "active", name: null, clientId: null })
        .where(eq(agentsTable.uuid, removed.agentId));

      const result = await repairMembershipHumanMirrors(app.db);
      expect(result).toEqual({ activeMirrorsRepaired: 1, inactiveMirrorsRepaired: 2 });

      const repairedRows = await app.db
        .select({
          uuid: agentsTable.uuid,
          type: agentsTable.type,
          status: agentsTable.status,
          name: agentsTable.name,
          displayName: agentsTable.displayName,
          clientId: agentsTable.clientId,
        })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [admin.humanAgentUuid, left.agentId, removed.agentId]));
      const byId = new Map(repairedRows.map((row) => [row.uuid, row]));
      expect(byId.get(admin.humanAgentUuid)).toMatchObject({
        type: "human",
        status: "active",
        displayName: "Test Admin",
        clientId: null,
      });
      expect(byId.get(admin.humanAgentUuid)?.name).not.toBeNull();
      expect(byId.get(left.agentId)).toMatchObject({
        type: "human",
        status: "suspended",
        name: leftBefore?.name,
        clientId: null,
      });
      expect(byId.get(removed.agentId)).toMatchObject({ type: "human", status: "suspended", clientId: null });
      expect(byId.get(removed.agentId)?.name).not.toBeNull();
    });

    it("returns 404 and leaves the target intact when deleting a member from another org", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `delete-idor-admin-${randomUUID().slice(0, 8)}` });
      const { otherOrg, target } = await createOtherOrgTargetMember(app, "delete-idor");

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${admin.organizationId}/members/${target.id}`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(deleteRes.statusCode).toBe(404);

      const [memberRow] = await app.db
        .select({ id: membersTable.id, organizationId: membersTable.organizationId })
        .from(membersTable)
        .where(eq(membersTable.id, target.id))
        .limit(1);
      expect(memberRow).toEqual({ id: target.id, organizationId: otherOrg.id });

      const [agentRow] = await app.db
        .select({ status: agentsTable.status, name: agentsTable.name })
        .from(agentsTable)
        .where(eq(agentsTable.uuid, target.agentId))
        .limit(1);
      expect(agentRow?.status).toBe("active");
      expect(agentRow?.name).not.toBeNull();
    });
  });

  describe("permission enforcement", () => {
    it("member role cannot create members", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `member-admin-perm-${Date.now()}` });
      const orgId = admin.organizationId;
      const username = `member-user-${Date.now()}`;
      const createRes = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/members`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { username, displayName: "Regular Member", role: "member" },
      });
      const { password } = createRes.json<{ password: string }>();

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      const { accessToken } = loginRes.json<{ accessToken: string }>();

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/members`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { username: "another", displayName: "Another", role: "member" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("service-layer edge cases", () => {
    it("updateMember returns the current row for an empty patch and blocks demoting the last admin", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `member-edge-admin-${randomUUID().slice(0, 8)}` });

      const unchanged = await memberService.updateMember(app.db, admin.memberId, {}, admin.organizationId);
      expect(unchanged.id).toBe(admin.memberId);
      expect(unchanged.role).toBe("admin");

      await expect(
        memberService.updateMember(app.db, admin.memberId, { role: "member" }, admin.organizationId),
      ).rejects.toThrow(/last admin/i);
    });

    it("updateMember rejects inactive rows and allows demoting a non-final admin", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `member-demote-admin-${randomUUID().slice(0, 8)}` });
      const secondAdmin = await memberService.createMember(app.db, admin.organizationId, {
        username: `member-demote-second-${randomUUID().slice(0, 8)}`,
        displayName: "Second Admin",
        role: "admin",
      });
      const inactive = await memberService.createMember(app.db, admin.organizationId, {
        username: `member-inactive-update-${randomUUID().slice(0, 8)}`,
        displayName: "Inactive Update",
        role: "member",
      });
      await app.db.update(membersTable).set({ status: "removed" }).where(eq(membersTable.id, inactive.id));

      await expect(
        memberService.updateMember(app.db, inactive.id, { displayName: "Should Not Update" }, admin.organizationId),
      ).rejects.toThrow(/not found/i);

      const demoted = await memberService.updateMember(
        app.db,
        secondAdmin.id,
        { role: "member" },
        admin.organizationId,
      );
      expect(demoted.role).toBe("member");
      const [row] = await app.db
        .select({ role: membersTable.role })
        .from(membersTable)
        .where(eq(membersTable.id, secondAdmin.id))
        .limit(1);
      expect(row?.role).toBe("member");
    });

    it("updateMember keeps every human mirror aligned for a multi-org user", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `mirror-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `mirror-target-${randomUUID().slice(0, 8)}`,
        displayName: "Original Name",
        role: "member",
      });
      const side = await attachExistingUserToOtherOrg(app, {
        userId: target.userId,
        displayName: "Original Name",
        prefix: "mirror-side",
      });

      await memberService.updateMember(app.db, target.id, { displayName: "Unified Name" }, admin.organizationId);

      const [user] = await app.db
        .select({ displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, target.userId))
        .limit(1);
      const mirrors = await app.db
        .select({ uuid: agentsTable.uuid, displayName: agentsTable.displayName })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [target.agentId, side.agentId]));
      expect(user?.displayName).toBe("Unified Name");
      expect(mirrors).toHaveLength(2);
      expect(mirrors.every((mirror) => mirror.displayName === "Unified Name")).toBe(true);
    });

    it("treats an unchanged explicit display name as a mirror repair request", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `same-name-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `same-name-target-${randomUUID().slice(0, 8)}`,
        displayName: "Authoritative Name",
        role: "member",
      });
      const side = await attachExistingUserToOtherOrg(app, {
        userId: target.userId,
        displayName: "Authoritative Name",
        prefix: "same-name-side",
      });
      await app.db.update(agentsTable).set({ displayName: "Legacy Drift" }).where(eq(agentsTable.uuid, target.agentId));

      await memberService.updateMember(app.db, target.id, { displayName: "Authoritative Name" }, admin.organizationId);

      const mirrors = await app.db
        .select({ displayName: agentsTable.displayName })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [target.agentId, side.agentId]));
      expect(mirrors).toHaveLength(2);
      expect(mirrors.every((mirror) => mirror.displayName === "Authoritative Name")).toBe(true);
    });

    it("keeps all mirrors aligned when createMember restores an inactive membership", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `restore-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `restore-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Before Restore",
        role: "member",
      });
      const side = await attachExistingUserToOtherOrg(app, {
        userId: target.userId,
        displayName: "Before Restore",
        prefix: "restore-sync-side",
      });
      await app.db.update(membersTable).set({ status: "removed" }).where(eq(membersTable.id, target.id));
      await app.db.update(agentsTable).set({ status: "suspended" }).where(eq(agentsTable.uuid, target.agentId));

      const restored = await memberService.createMember(app.db, admin.organizationId, {
        username: target.username,
        displayName: "After Restore",
        role: "member",
      });

      expect(restored.id).toBe(target.id);
      const [user] = await app.db
        .select({ displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, target.userId));
      const mirrors = await app.db
        .select({ displayName: agentsTable.displayName })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [target.agentId, side.agentId]));
      expect(user?.displayName).toBe("After Restore");
      expect(mirrors.every((mirror) => mirror.displayName === "After Restore")).toBe(true);
    });

    it("keeps all mirrors aligned when createMember adds an existing user to another organization", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `add-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `add-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Before Add",
        role: "member",
      });
      const sideOrg = await createOrganization(app.db, {
        name: `add-sync-side-${randomUUID().slice(0, 8)}`,
        displayName: "Add Sync Side",
      });

      const added = await memberService.createMember(app.db, sideOrg.id, {
        username: target.username,
        displayName: "After Add",
        role: "member",
      });

      const [user] = await app.db
        .select({ displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, target.userId));
      const mirrors = await app.db
        .select({ displayName: agentsTable.displayName })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [target.agentId, added.agentId]));
      expect(user?.displayName).toBe("After Add");
      expect(mirrors).toHaveLength(2);
      expect(mirrors.every((mirror) => mirror.displayName === "After Add")).toBe(true);
    });

    it("keeps the locked authoritative label when ensureMembership reactivates a membership", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `ensure-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `ensure-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Before Ensure",
        role: "member",
      });
      const side = await attachExistingUserToOtherOrg(app, {
        userId: target.userId,
        displayName: "Before Ensure",
        prefix: "ensure-sync-side",
      });
      await app.db.update(membersTable).set({ status: "left" }).where(eq(membersTable.id, target.id));
      await app.db.update(agentsTable).set({ status: "suspended" }).where(eq(agentsTable.uuid, target.agentId));

      await ensureMembership(app.db, {
        userId: target.userId,
        organizationId: admin.organizationId,
        role: "member",
        displayName: "After Ensure",
        username: target.username,
      });

      const [user] = await app.db
        .select({ displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, target.userId));
      const mirrors = await app.db
        .select({ displayName: agentsTable.displayName })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [target.agentId, side.agentId]));
      expect(user?.displayName).toBe("Before Ensure");
      expect(mirrors.every((mirror) => mirror.displayName === "Before Ensure")).toBe(true);
    });

    it("keeps reactivation on the user-to-member-to-agent lock order", async () => {
      const app = getApp();
      const databaseUrl = process.env.DATABASE_URL ?? "";
      if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
      const admin = await createTestAdmin(app, { username: `lock-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `lock-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Lock Identity",
        role: "member",
      });
      await app.db.update(membersTable).set({ status: "left" }).where(eq(membersTable.id, target.id));
      await app.db.update(agentsTable).set({ status: "suspended" }).where(eq(agentsTable.uuid, target.agentId));

      const applicationName = `membership_reactivate_${randomUUID().slice(0, 8)}`;
      const reactivationDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName));
      const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      let blockerCommitted = false;
      try {
        await blocker`BEGIN`;
        await blocker`SELECT id FROM users WHERE id = ${target.userId} FOR NO KEY UPDATE`;

        const reactivation = ensureMembership(reactivationDb, {
          userId: target.userId,
          organizationId: admin.organizationId,
          role: "member",
          displayName: "Lock Identity",
          username: target.username,
        });
        await waitForPostgresLockWait(observer, applicationName);

        // A reactivation that touched the member before waiting on the user
        // would deadlock here. The canonical user -> member -> agents order
        // leaves the lifecycle row available to this holder.
        await blocker`SELECT id FROM members WHERE id = ${target.id} FOR UPDATE`;
        await blocker`COMMIT`;
        blockerCommitted = true;
        await reactivation;
      } finally {
        if (!blockerCommitted) await blocker`ROLLBACK`;
        await reactivationDb.end();
        await blocker.end();
        await observer.end();
      }
    });

    it("locks the user before claiming a new membership's unique slot", async () => {
      const app = getApp();
      const databaseUrl = process.env.DATABASE_URL ?? "";
      if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
      const admin = await createTestAdmin(app, { username: `slot-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `slot-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Slot Identity",
        role: "member",
      });
      const destination = await createOrganization(app.db, {
        name: `slot-sync-destination-${randomUUID().slice(0, 8)}`,
        displayName: "Slot Destination",
      });

      const applicationName = `membership_slot_${randomUUID().slice(0, 8)}`;
      const joiningDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName));
      const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      const insertedMemberId = randomUUID();
      const insertedAgentId = randomUUID();
      let blockerCommitted = false;
      try {
        await blocker`BEGIN`;
        await blocker`SELECT id FROM users WHERE id = ${target.userId} FOR NO KEY UPDATE`;

        const joining = ensureMembership(joiningDb, {
          userId: target.userId,
          organizationId: destination.id,
          role: "member",
          displayName: "Slot Identity",
          username: target.username,
        });
        await waitForPostgresLockWait(observer, applicationName);

        // The user-lock holder represents an OAuth invite flow that wins the
        // same unique membership slot. A contender must still be waiting on
        // the user rather than holding the unique index entry.
        await blocker`
          INSERT INTO agents (uuid, name, organization_id, type, display_name, inbox_id, manager_id)
          VALUES (
            ${insertedAgentId},
            ${`slot-human-${randomUUID().slice(0, 8)}`},
            ${destination.id},
            'human',
            'Slot Identity',
            ${`inbox_${insertedAgentId}`},
            ${insertedMemberId}
          )
        `;
        await blocker`
          INSERT INTO members (id, user_id, organization_id, agent_id, role, status)
          VALUES (${insertedMemberId}, ${target.userId}, ${destination.id}, ${insertedAgentId}, 'member', 'active')
        `;
        await blocker`COMMIT`;
        blockerCommitted = true;

        const result = await joining;
        expect(result.id).toBe(insertedMemberId);
      } finally {
        if (!blockerCommitted) await blocker`ROLLBACK`;
        await joiningDb.end();
        await blocker.end();
        await observer.end();
      }
    });

    it("does not let a stale lifecycle snapshot overwrite a committed profile rename", async () => {
      const app = getApp();
      const databaseUrl = process.env.DATABASE_URL ?? "";
      if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
      const admin = await createTestAdmin(app, { username: `snapshot-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `snapshot-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Old Identity",
        role: "member",
      });
      const destination = await createOrganization(app.db, {
        name: `snapshot-sync-destination-${randomUUID().slice(0, 8)}`,
        displayName: "Snapshot Destination",
      });

      const applicationName = `membership_snapshot_${randomUUID().slice(0, 8)}`;
      const joiningDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName));
      const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      let blockerCommitted = false;
      try {
        await blocker`BEGIN`;
        await blocker`SELECT id FROM users WHERE id = ${target.userId} FOR NO KEY UPDATE`;
        await blocker`UPDATE users SET display_name = 'New Identity' WHERE id = ${target.userId}`;
        await blocker`UPDATE agents SET display_name = 'New Identity' WHERE uuid = ${target.agentId}`;

        const joining = ensureMembership(joiningDb, {
          userId: target.userId,
          organizationId: destination.id,
          role: "member",
          // Represents a label read before the profile rename acquired its lock.
          displayName: "Old Identity",
          username: target.username,
        });
        await waitForPostgresLockWait(observer, applicationName);
        await blocker`COMMIT`;
        blockerCommitted = true;

        const joined = await joining;
        const [user] = await app.db
          .select({ displayName: usersTable.displayName })
          .from(usersTable)
          .where(eq(usersTable.id, target.userId));
        const mirrors = await app.db
          .select({ displayName: agentsTable.displayName })
          .from(agentsTable)
          .where(inArray(agentsTable.uuid, [target.agentId, joined.agentId]));
        expect(user?.displayName).toBe("New Identity");
        expect(mirrors).toHaveLength(2);
        expect(mirrors.every((mirror) => mirror.displayName === "New Identity")).toBe(true);
      } finally {
        if (!blockerCommitted) await blocker`ROLLBACK`;
        await joiningDb.end();
        await blocker.end();
        await observer.end();
      }
    });

    it("does not let startup repair overwrite a concurrently committed rename", async () => {
      const app = getApp();
      const databaseUrl = process.env.DATABASE_URL ?? "";
      if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
      const target = await createTestAdmin(app, { username: `repair-race-${randomUUID().slice(0, 8)}` });
      const applicationName = `membership_repair_${randomUUID().slice(0, 8)}`;
      const repairDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName));
      const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
      let blockerCommitted = false;
      try {
        await blocker`BEGIN`;
        await blocker`SELECT id FROM users WHERE id = ${target.userId} FOR NO KEY UPDATE`;
        await blocker`SELECT uuid FROM agents WHERE uuid = ${target.humanAgentUuid} FOR UPDATE`;

        const repair = repairMembershipHumanMirrors(repairDb);
        await waitForPostgresLockWait(observer, applicationName);
        await blocker`UPDATE users SET display_name = 'Concurrent Rename' WHERE id = ${target.userId}`;
        await blocker`UPDATE agents SET display_name = 'Concurrent Rename' WHERE uuid = ${target.humanAgentUuid}`;
        await blocker`COMMIT`;
        blockerCommitted = true;
        await repair;

        const [user] = await app.db
          .select({ displayName: usersTable.displayName })
          .from(usersTable)
          .where(eq(usersTable.id, target.userId));
        const [mirror] = await app.db
          .select({ displayName: agentsTable.displayName })
          .from(agentsTable)
          .where(eq(agentsTable.uuid, target.humanAgentUuid));
        expect(user?.displayName).toBe("Concurrent Rename");
        expect(mirror?.displayName).toBe("Concurrent Rename");
      } finally {
        if (!blockerCommitted) await blocker`ROLLBACK`;
        await repairDb.end();
        await blocker.end();
        await observer.end();
      }
    });

    it("uses an idempotent active ensure to repair legacy mirror drift", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `active-sync-admin-${randomUUID().slice(0, 8)}` });
      const target = await memberService.createMember(app.db, admin.organizationId, {
        username: `active-sync-target-${randomUUID().slice(0, 8)}`,
        displayName: "Active Identity",
        role: "member",
      });
      const side = await attachExistingUserToOtherOrg(app, {
        userId: target.userId,
        displayName: "Active Identity",
        prefix: "active-sync-side",
      });
      await app.db.update(agentsTable).set({ displayName: "Legacy Drift" }).where(eq(agentsTable.uuid, side.agentId));

      await ensureMembership(app.db, {
        userId: target.userId,
        organizationId: admin.organizationId,
        role: "member",
        displayName: "Active Identity",
        username: target.username,
      });

      const mirrors = await app.db
        .select({ displayName: agentsTable.displayName })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [target.agentId, side.agentId]));
      expect(mirrors).toHaveLength(2);
      expect(mirrors.every((mirror) => mirror.displayName === "Active Identity")).toBe(true);
    });

    it("createMember rejects an existing row with an unsupported lifecycle status", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `unsupported-admin-${randomUUID().slice(0, 8)}` });
      const created = await memberService.createMember(app.db, admin.organizationId, {
        username: `unsupported-${randomUUID().slice(0, 8)}`,
        displayName: "Unsupported Member",
        role: "member",
      });
      await app.db.update(membersTable).set({ status: "paused" }).where(eq(membersTable.id, created.id));

      await expect(
        memberService.createMember(app.db, admin.organizationId, {
          username: created.username,
          displayName: "Unsupported Again",
          role: "member",
        }),
      ).rejects.toThrow(/unsupported membership status/i);
    });

    it("deleteMember requires another active admin even for a non-admin target", async () => {
      const app = getApp();
      const org = await createOrganization(app.db, {
        name: `delete-no-fallback-${randomUUID().slice(0, 8)}`,
        displayName: "No Fallback Org",
      });
      const target = await memberService.createMember(app.db, org.id, {
        username: `delete-no-fallback-${randomUUID().slice(0, 8)}`,
        displayName: "Only Member",
        role: "member",
      });

      await expect(memberService.deleteMember(app.db, target.id, org.id)).rejects.toThrow(/another admin/i);
    });

    it("deleteMember rejects removing the only active admin", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `delete-only-admin-${randomUUID().slice(0, 8)}` });

      await expect(memberService.deleteMember(app.db, admin.memberId, admin.organizationId)).rejects.toThrow(
        /last admin/i,
      );
    });

    it("restores a left member whose human mirror name was cleared with a collision-safe slug", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `restore-null-admin-${randomUUID().slice(0, 8)}` });
      const username = `restore-null-${randomUUID().slice(0, 8)}`;
      const created = await memberService.createMember(app.db, admin.organizationId, {
        username,
        displayName: "Restore Null",
        role: "member",
      });
      await app.db.update(membersTable).set({ status: "left" }).where(eq(membersTable.id, created.id));
      await app.db
        .update(agentsTable)
        .set({ status: "suspended", name: null })
        .where(eq(agentsTable.uuid, created.agentId));
      await createAgent(app.db, {
        name: username,
        type: "agent",
        displayName: "Slug Collision",
        managerId: admin.memberId,
        organizationId: admin.organizationId,
      });

      const restored = await memberService.createMember(app.db, admin.organizationId, {
        username,
        displayName: "Restored Null",
        role: "admin",
      });

      expect(restored.id).toBe(created.id);
      const [mirror] = await app.db
        .select({ name: agentsTable.name, status: agentsTable.status })
        .from(agentsTable)
        .where(eq(agentsTable.uuid, created.agentId))
        .limit(1);
      expect(mirror?.status).toBe("active");
      expect(mirror?.name).toContain(created.agentId.slice(0, 8));
    });

    it("selfCreateOrganization rejects duplicate and reserved slugs", async () => {
      const app = getApp();

      await expect(
        selfCreateOrganization(app.db, {
          userId: `user-${randomUUID()}`,
          userDisplayName: "Self Org Admin",
          username: "self-org-admin",
          name: "default",
          displayName: "Default Again",
        }),
      ).rejects.toThrow(/already exists/i);

      await app.db.delete(organizationsTable).where(eq(organizationsTable.name, "default"));
      await expect(
        selfCreateOrganization(app.db, {
          userId: `user-${randomUUID()}`,
          userDisplayName: "Self Org Admin",
          username: "self-org-admin",
          name: "default",
          displayName: "Reserved Default",
        }),
      ).rejects.toThrow(/reserved organization name/i);
    });
  });
});
