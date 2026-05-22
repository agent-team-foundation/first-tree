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
    await expect(createAgent(app.db, { name: "__hub_system_tasks", type: "agent" })).rejects.toThrow(/reserved/i);
  });

  it("retrieves an agent created via service", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: "agent-1",
      type: "agent",
      displayName: "Bot One",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const getRes = await req("GET", `/api/v1/agents/${agent.uuid}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().uuid).toBe(agent.uuid);
    expect(getRes.json().inboxId).toBe(`inbox_${agent.uuid}`);
  });

  it("lists agents with pagination", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    await createAgent(app.db, { name: "a1", type: "human" });
    await createAgent(app.db, { name: "a2", type: "human" });

    const res = await req("GET", `/api/v1/orgs/${ctx.organizationId}/agents?limit=1`);
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
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const res = await req("GET", `/api/v1/orgs/${ctx.organizationId}/agents?limit=50`);
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

    const res = await req("POST", `/api/v1/orgs/${ctx.organizationId}/agents`, {
      name: "api-created",
      type: "agent",
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

    const res = await req("PATCH", `/api/v1/agents/${agent.uuid}`, {
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
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Suspend
    const suspendRes = await req("POST", `/api/v1/agents/${agent.uuid}/suspend`);
    expect(suspendRes.statusCode).toBe(200);
    expect(suspendRes.json().status).toBe("suspended");

    // Reactivate
    const reactivateRes = await req("POST", `/api/v1/agents/${agent.uuid}/reactivate`);
    expect(reactivateRes.statusCode).toBe(200);
    expect(reactivateRes.json().status).toBe("active");
  });

  it("deletes only suspended agents", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const agent = await createAgent(app.db, {
      name: "delete-test",
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Cannot delete active agent
    const failRes = await req("DELETE", `/api/v1/agents/${agent.uuid}`);
    expect(failRes.statusCode).toBe(400);

    // Suspend first, then delete
    await req("POST", `/api/v1/agents/${agent.uuid}/suspend`);
    const okRes = await req("DELETE", `/api/v1/agents/${agent.uuid}`);
    expect(okRes.statusCode).toBe(204);
  });

  it("rejects unauthenticated requests", async () => {
    const app = getApp();
    // No-auth call — server must 401 before resolving the org. Use a
    // throwaway org id; the response is shape-checked, not membership-checked.
    const res = await app.inject({ method: "GET", url: "/api/v1/orgs/any/agents" });
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

    it("creates the agent in the URL's org regardless of any body.organizationId", async () => {
      const app = getApp();
      const alice = await createTestAdmin(app);
      const orgB = await attachOrg(app, alice.userId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/agents`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          name: `url-wins-${crypto.randomUUID().slice(0, 6)}`,
          type: "agent",
          displayName: "URL Wins",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ organizationId: string }>().organizationId).toBe(orgB.orgId);
    });

    it("rejects when the URL targets an org the caller has no membership in (403)", async () => {
      const app = getApp();
      const alice = await createTestAdmin(app);
      const orgC = `org-prec-c-${crypto.randomUUID().slice(0, 8)}`;
      await app.db.insert(organizations).values({ id: orgC, name: orgC.slice(0, 30), displayName: "Outside" });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${encodeURIComponent(orgC)}/agents`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          name: `cross-org-no-${crypto.randomUUID().slice(0, 6)}`,
          type: "agent",
          displayName: "Cross-Org Forbidden",
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * `POST /admin/agents/:uuid/chats` used to read `requireMember(request)` and
   * use the JWT-default-org HUMAN agent as the chat creator, even when the
   * target agent lived in a non-default org. The inline onboarding flow then
   * tripped `createChat`'s cross-organization guard ("Cross-organization chat
   * not allowed: <uuid>") right after a successful agent create. The fix
   * resolves the creator from the *target agent's* org via
   * `requireMemberInOrg`.
   */
  describe("chat-create resolves creator in target agent's org", () => {
    async function attachOrg(
      app: FastifyInstance,
      userId: string,
      role: "admin" | "member",
    ): Promise<{ orgId: string; memberId: string; humanAgentId: string }> {
      const orgId = `org-chat-${crypto.randomUUID().slice(0, 8)}`;
      const memberId = uuidv7();
      let humanAgentId = "";
      await app.db.transaction(async (tx) => {
        await tx
          .insert(organizations)
          .values({ id: orgId, name: `chat-${crypto.randomUUID().slice(0, 6)}`, displayName: "Chat Side" });
        const human = await createAgent(tx as unknown as typeof app.db, {
          name: `chat-h-${crypto.randomUUID().slice(0, 6)}`,
          type: "human",
          displayName: "Chat Human",
          managerId: memberId,
          organizationId: orgId,
        });
        humanAgentId = human.uuid;
        await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
      });
      return { orgId, memberId, humanAgentId };
    }

    it("creates a direct chat when the target agent lives in a non-default org", async () => {
      const app = getApp();
      const alice = await createAdminContext(app);
      const orgB = await attachOrg(app, alice.userId, "admin");

      // Agent in non-default org B; managed by Alice's org-B member.
      const target = await createAgent(app.db, {
        name: `chat-target-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Chat Target",
        managerId: orgB.memberId,
        clientId: alice.clientId,
        organizationId: orgB.orgId,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${target.uuid}/chats`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; participants: Array<{ agentId: string }> }>();
      // Both the target and Alice's org-B human must be participants — the
      // pre-fix code would have used Alice's default-org human, blowing up
      // with the cross-organization guard before reaching this assertion.
      const ids = body.participants.map((p) => p.agentId);
      expect(ids).toContain(target.uuid);
      expect(ids).toContain(orgB.humanAgentId);
    });

    it("404s when the caller has no membership in the target agent's org", async () => {
      const app = getApp();
      const alice = await createAdminContext(app);

      // Stand up a separate org with a fresh user (Bob) as admin. Two
      // createTestAdmin calls would both land in resolveDefaultOrgId, so
      // we provision Bob's org inline.
      const { users } = await import("../db/schema/users.js");
      const bobOrgId = `org-chat-bob-${crypto.randomUUID().slice(0, 8)}`;
      const bobMemberId = uuidv7();
      const bobUserId = uuidv7();
      const targetUuid = await app.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: bobUserId,
          username: `bob-${crypto.randomUUID().slice(0, 6)}`,
          passwordHash: "$2b$04$xxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
          displayName: "Bob",
        });
        await tx.insert(organizations).values({ id: bobOrgId, name: bobOrgId.slice(0, 30), displayName: "Bob's Org" });
        const bobHuman = await createAgent(tx as unknown as typeof app.db, {
          name: `bob-h-${crypto.randomUUID().slice(0, 6)}`,
          type: "human",
          displayName: "Bob Human",
          managerId: bobMemberId,
          organizationId: bobOrgId,
        });
        await tx.insert(members).values({
          id: bobMemberId,
          userId: bobUserId,
          organizationId: bobOrgId,
          agentId: bobHuman.uuid,
          role: "admin",
        });
        // Bob's autonomous agent in his own org — Alice has no membership here.
        const bobAgent = await createAgent(tx as unknown as typeof app.db, {
          name: `bob-target-${crypto.randomUUID().slice(0, 6)}`,
          type: "agent",
          displayName: "Bob's Target",
          managerId: bobMemberId,
          organizationId: bobOrgId,
        });
        return bobAgent.uuid;
      });

      // Alice tries to start a chat with Bob's agent. The route's
      // `assertAgentVisible` runs first and 404s on non-members of the
      // target's org (404 rather than 403 prevents UUID enumeration). The
      // post-fix `requireMemberInOrg` is unreachable on this path — both
      // layers agree the request is not authorized.
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${targetUuid}/chats`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
