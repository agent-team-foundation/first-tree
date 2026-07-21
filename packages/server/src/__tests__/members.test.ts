import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents as agentsTable } from "../db/schema/agents.js";
import { members as membersTable } from "../db/schema/members.js";
import { organizations as organizationsTable } from "../db/schema/organizations.js";
import { users as usersTable } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as memberService from "../services/member.js";
import { repairMembershipHumanMirrors, selfCreateOrganization } from "../services/membership.js";
import { createOrganization } from "../services/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

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
        .set({ type: "agent", status: "deleted", name: null, clientId: null })
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
          clientId: agentsTable.clientId,
        })
        .from(agentsTable)
        .where(inArray(agentsTable.uuid, [admin.humanAgentUuid, left.agentId, removed.agentId]));
      const byId = new Map(repairedRows.map((row) => [row.uuid, row]));
      expect(byId.get(admin.humanAgentUuid)).toMatchObject({ type: "human", status: "active", clientId: null });
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
      const sideOrg = await createOrganization(app.db, {
        name: `mirror-side-${randomUUID().slice(0, 8)}`,
        displayName: "Mirror Side",
      });
      const sideMemberId = randomUUID();
      let sideAgentId = "";
      await app.db.transaction(async (tx) => {
        const sideHuman = await createAgent(tx as unknown as typeof app.db, {
          name: `mirror-human-${randomUUID().slice(0, 8)}`,
          type: "human",
          displayName: "Original Name",
          managerId: sideMemberId,
          organizationId: sideOrg.id,
        });
        sideAgentId = sideHuman.uuid;
        await tx.insert(membersTable).values({
          id: sideMemberId,
          userId: target.userId,
          organizationId: sideOrg.id,
          agentId: sideAgentId,
          role: "member",
        });
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
        .where(inArray(agentsTable.uuid, [target.agentId, sideAgentId]));
      expect(user?.displayName).toBe("Unified Name");
      expect(mirrors).toHaveLength(2);
      expect(mirrors.every((mirror) => mirror.displayName === "Unified Name")).toBe(true);
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
