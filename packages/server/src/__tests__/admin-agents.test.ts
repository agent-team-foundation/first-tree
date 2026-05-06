import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, useTestApp } from "./helpers.js";

describe("Admin Agents API", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const ctx = await createAdminContext(app);
    const req = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        ...(payload ? { payload } : {}),
      });
    return { req, ctx };
  }

  it("rejects creating an agent with a reserved `__` name prefix", async () => {
    const app = getApp();
    await expect(createAgent(app.db, { name: "__hub_system_tasks", type: "autonomous_agent" })).rejects.toThrow(
      /reserved/i,
    );
  });

  it("retrieves an agent created via service", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: "agent-1",
      type: "autonomous_agent",
      displayName: "Bot One",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const getRes = await req("GET", `/api/v1/admin/agents/${agent.uuid}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().uuid).toBe(agent.uuid);
    expect(getRes.json().inboxId).toBe(`inbox_${agent.uuid}`);
  });

  it("lists agents with pagination", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);
    await createAgent(app.db, { name: "a1", type: "human" });
    await createAgent(app.db, { name: "a2", type: "human" });

    const res = await req("GET", "/api/v1/admin/agents?limit=1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeDefined();
  });

  it("lists agents with presenceStatus field", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const created = await createAgent(app.db, {
      name: "presence-test",
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const res = await req("GET", "/api/v1/admin/agents?limit=50");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const agent = body.items.find((a: { uuid: string }) => a.uuid === created.uuid);
    expect(agent).toBeDefined();
    // No presence record → defaults to "offline"
    expect(agent.presenceStatus).toBe("offline");
  });

  it("creates an agent via POST", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/agents", {
      name: "api-created",
      type: "autonomous_agent",
      displayName: "API Bot",
      metadata: { role: "testing" },
      clientId: ctx.clientId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("api-created");
    expect(body.displayName).toBe("API Bot");
    expect(body.metadata.role).toBe("testing");
  });

  it("updates an agent via PATCH", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);
    const agent = await createAgent(app.db, { name: "patch-target", type: "human", displayName: "Old Name" });

    const res = await req("PATCH", `/api/v1/admin/agents/${agent.uuid}`, {
      displayName: "New Name",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("New Name");
  });

  it("suspends and reactivates an agent", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const agent = await createAgent(app.db, {
      name: "lifecycle-agent",
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Suspend
    const suspendRes = await req("POST", `/api/v1/admin/agents/${agent.uuid}/suspend`);
    expect(suspendRes.statusCode).toBe(200);
    expect(suspendRes.json().status).toBe("suspended");

    // Reactivate
    const reactivateRes = await req("POST", `/api/v1/admin/agents/${agent.uuid}/reactivate`);
    expect(reactivateRes.statusCode).toBe(200);
    expect(reactivateRes.json().status).toBe("active");
  });

  it("deletes only suspended agents", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const agent = await createAgent(app.db, {
      name: "delete-test",
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Cannot delete active agent
    const failRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(failRes.statusCode).toBe(400);

    // Suspend first, then delete
    await req("POST", `/api/v1/admin/agents/${agent.uuid}/suspend`);
    const okRes = await req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
    expect(okRes.statusCode).toBe(204);
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/agents" });
    expect(res.statusCode).toBe(401);
  });

  /**
   * PR #220 — `POST /admin/agents` resolves the target organization with
   * precedence `body > query > JWT default`. The query-string fallback exists
   * because the api-client `decoratePath` (in `packages/web/src/api/client.ts`)
   * injects `?organizationId=<selectedOrgId>` into every `/admin/*` URL; the
   * pre-#220 handler ignored that on writes, silently creating agents in the
   * JWT default org regardless of what the user's dropdown showed.
   */
  describe("org precedence on create", () => {
    /** Attach `userId` to a fresh org with the requested role. Mirrors the
     * helper in admin-realtime-role.test.ts. */
    async function attachOrg(
      app: FastifyInstance,
      userId: string,
      role: "admin" | "member",
    ): Promise<{ orgId: string; memberId: string }> {
      const orgId = `org-prec-${crypto.randomUUID().slice(0, 8)}`;
      const memberId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx
          .insert(organizations)
          .values({ id: orgId, name: `prec-${crypto.randomUUID().slice(0, 6)}`, displayName: "Precedence Side" });
        const human = await createAgent(tx as unknown as typeof app.db, {
          name: `prec-h-${crypto.randomUUID().slice(0, 6)}`,
          type: "human",
          displayName: "Prec Human",
          managerId: memberId,
          organizationId: orgId,
        });
        await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
      });
      return { orgId, memberId };
    }

    it("body.organizationId wins over JWT default", async () => {
      const app = getApp();
      const alice = await createTestAdmin(app);
      const orgB = await attachOrg(app, alice.userId, "admin");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/agents",
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          name: `body-wins-${crypto.randomUUID().slice(0, 6)}`,
          type: "autonomous_agent",
          displayName: "Body Wins",
          organizationId: orgB.orgId,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ organizationId: string }>().organizationId).toBe(orgB.orgId);
    });

    it("?organizationId= wins over JWT default when body omits it (decoratePath fallback)", async () => {
      const app = getApp();
      const alice = await createTestAdmin(app);
      const orgB = await attachOrg(app, alice.userId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admin/agents?organizationId=${encodeURIComponent(orgB.orgId)}`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          name: `query-wins-${crypto.randomUUID().slice(0, 6)}`,
          type: "autonomous_agent",
          displayName: "Query Wins",
          // intentionally no organizationId in body — mirrors what the web
          // sends when the developer forgets to thread the selected org
          // through the mutation
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ organizationId: string }>().organizationId).toBe(orgB.orgId);
    });

    it("body.organizationId wins over ?organizationId= when both are set", async () => {
      const app = getApp();
      const alice = await createTestAdmin(app);
      const orgB = await attachOrg(app, alice.userId, "admin");
      const orgC = await attachOrg(app, alice.userId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admin/agents?organizationId=${encodeURIComponent(orgC.orgId)}`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          name: `body-over-query-${crypto.randomUUID().slice(0, 6)}`,
          type: "autonomous_agent",
          displayName: "Body Over Query",
          organizationId: orgB.orgId,
        },
      });
      expect(res.statusCode).toBe(201);
      // Body's orgB wins over query's orgC.
      expect(res.json<{ organizationId: string }>().organizationId).toBe(orgB.orgId);
    });

    it("rejects ?organizationId= for an org the caller has no membership in (403 via requireMemberInOrg)", async () => {
      const app = getApp();
      const alice = await createTestAdmin(app);
      // brand-new org Alice never joined
      const orgC = `org-prec-c-${crypto.randomUUID().slice(0, 8)}`;
      await app.db.insert(organizations).values({ id: orgC, name: orgC.slice(0, 30), displayName: "Outside" });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admin/agents?organizationId=${encodeURIComponent(orgC)}`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          name: `cross-org-no-${crypto.randomUUID().slice(0, 6)}`,
          type: "autonomous_agent",
          displayName: "Cross-Org Forbidden",
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
