import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents as agentsTable } from "../db/schema/agents.js";
import { members as membersTable } from "../db/schema/members.js";
import * as memberService from "../services/member.js";
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
      const body = res.json<Array<{ id: string; username: string; role: string }>>();
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty("username");
      expect(body[0]).toHaveProperty("role");
      expect(body[0]).toHaveProperty("agentId");
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
      const body = res.json<{ id: string; username: string; password: string; role: string; agentId: string }>();
      expect(body.password).toBeDefined();
      expect(body.password.length).toBeGreaterThan(0);
      expect(body.role).toBe("member");
      expect(body.agentId).toBeDefined();
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
    it("deletes member and deactivates their agent", async () => {
      const app = getApp();
      const req = await authedRequest(app);
      const createRes = await req("POST", "/api/v1/members", {
        username: `delete-${Date.now()}`,
        displayName: "Deletable",
        role: "member",
      });
      const { id } = createRes.json<{ id: string }>();

      const deleteRes = await req("DELETE", `/api/v1/members/${id}`);
      expect(deleteRes.statusCode).toBe(204);

      // Verify member is gone from list
      const listRes = await req("GET", "/api/v1/members");
      const members = listRes.json<Array<{ id: string }>>();
      expect(members.find((m: { id: string }) => m.id === id)).toBeUndefined();
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
});
