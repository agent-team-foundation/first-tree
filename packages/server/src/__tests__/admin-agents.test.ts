import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { bindAgent, unbindAgent } from "../services/presence.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, useTestApp, workerObjectStorage } from "./helpers.js";

describe("Admin Agents API", () => {
  const getApp = useTestApp({ objectStorage: workerObjectStorage() });

  async function authedRequest(app: FastifyInstance) {
    const ctx = await createAdminContext(app);
    const req = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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

  // Single-agent GET carries `runtimeState` from the unified
  // `selectAgentRowWithRuntime` projection. Management surfaces (Team /
  // Settings) derive reachability from this (`<PresenceChip status={
  // runtimeStateToPresence(agent.runtimeState) }>`), so an unbound agent
  // must surface `null` and a bound one must surface `"idle"`. PR #571
  // first cut shipped without this projection — agent-detail rendered a
  // permanent "Offline" because the field was undefined on the wire.
  it("GET /agents/:uuid carries runtimeState (null unbound, 'idle' bound)", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: `runtime-state-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Unbound (no agent_presence row) → runtimeState should be null
    const beforeBind = await req("GET", `/api/v1/agents/${agent.uuid}`);
    expect(beforeBind.statusCode).toBe(200);
    expect(beforeBind.json().runtimeState).toBeNull();

    // Bound via the runtime → flipped to "idle"
    await bindAgent(app.db, agent.uuid, {
      clientId: ctx.clientId,
      instanceId: `inst-${crypto.randomUUID().slice(0, 6)}`,
      runtimeType: "claude-code",
    });
    const afterBind = await req("GET", `/api/v1/agents/${agent.uuid}`);
    expect(afterBind.statusCode).toBe(200);
    expect(afterBind.json().runtimeState).toBe("idle");

    // Unbind → back to null
    await unbindAgent(app.db, agent.uuid);
    const afterUnbind = await req("GET", `/api/v1/agents/${agent.uuid}`);
    expect(afterUnbind.statusCode).toBe(200);
    expect(afterUnbind.json().runtimeState).toBeNull();
  });

  // Regression guard for the mutation-response path. PR #571 review
  // (yuezengwu second-pass) flagged that fixing only `requireAgentAccess`
  // would still leave PATCH / suspend / reactivate responses
  // without `runtimeState`, because those serialize the mutation's
  // `.returning()` row rather than `requireAgentAccess`'s. The fix
  // routes every mutation service through `selectAgentRowWithRuntime`
  // after the UPDATE.
  it("PATCH /agents/:uuid response carries runtimeState from the unified projection", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const agent = await createAgent(app.db, {
      name: `patch-runtime-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await bindAgent(app.db, agent.uuid, {
      clientId: ctx.clientId,
      instanceId: `inst-${crypto.randomUUID().slice(0, 6)}`,
      runtimeType: "claude-code",
    });

    const res = await req("PATCH", `/api/v1/agents/${agent.uuid}`, { displayName: "Renamed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Renamed");
    expect(res.json().runtimeState).toBe("idle");
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

  it("GET /orgs/:orgId/agents/all lists every agent for admins", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const created = await createAgent(app.db, {
      name: `all-list-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "All List Agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      metadata: { publicRole: "admin-all" },
    });

    const res = await req("GET", `/api/v1/orgs/${ctx.organizationId}/agents/all?limit=50`);

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>();
    const agent = body.items.find((item) => item.uuid === created.uuid);
    expect(agent).toMatchObject({
      uuid: created.uuid,
      name: created.name,
      displayName: "All List Agent",
      managerId: ctx.memberId,
      presenceStatus: "offline",
      clientId: ctx.clientId,
      runtimeType: null,
      runtimeState: null,
      activeSessions: null,
      lastSeenAt: null,
      avatarImageUrl: null,
      metadata: { publicRole: "admin-all" },
    });
    expect(typeof agent?.createdAt).toBe("string");
    expect(typeof agent?.updatedAt).toBe("string");
  });

  it("GET /orgs/:orgId/agents/names/:name/availability reports route-level availability", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const takenName = `taken-${crypto.randomUUID().slice(0, 6)}`;
    await createAgent(app.db, {
      name: takenName,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const taken = await req("GET", `/api/v1/orgs/${ctx.organizationId}/agents/names/${takenName}/availability`);
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toMatchObject({ available: false, reason: "taken" });

    const availableName = `free-${crypto.randomUUID().slice(0, 6)}`;
    const available = await req("GET", `/api/v1/orgs/${ctx.organizationId}/agents/names/${availableName}/availability`);
    expect(available.statusCode).toBe(200);
    expect(available.json()).toMatchObject({ available: true });
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

  it("rejects user-supplied internal runtime metadata on create", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const res = await req("POST", `/api/v1/orgs/${ctx.organizationId}/agents`, {
      name: `reserved-meta-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Reserved Metadata",
      metadata: { runtimeSwitch: { claimId: "fake-claim" } },
      clientId: ctx.clientId,
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects public creation of standalone human agents", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const res = await req("POST", `/api/v1/orgs/${ctx.organizationId}/agents`, {
      name: `api-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "API Human",
    });

    expect(res.statusCode).toBe(400);
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

  it("rejects display-name PATCHes that bypass membership-backed human identity", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    const [before] = await app.db
      .select({ displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, ctx.humanAgentUuid));

    const res = await req("PATCH", `/api/v1/agents/${ctx.humanAgentUuid}`, {
      displayName: "Drifted Human",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/member or profile endpoint/i);
    const [after] = await app.db
      .select({ displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, ctx.humanAgentUuid));
    expect(after?.displayName).toBe(before?.displayName);
  });

  it("rejects user-supplied internal runtime metadata on PATCH", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);
    const agent = await createAgent(app.db, {
      name: `patch-reserved-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
    });

    const res = await req("PATCH", `/api/v1/agents/${agent.uuid}`, {
      metadata: { runtimeSwitch: { claimId: "fake-claim" } },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects manager reassignment by non-admin managers", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, ctx.memberId));
    const agent = await createAgent(app.db, {
      name: `patch-manager-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const res = await req("PATCH", `/api/v1/agents/${agent.uuid}`, {
      managerId: ctx.memberId,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toContain("Only admins can reassign");
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

  it("rejects direct lifecycle changes for human agents", async () => {
    const app = getApp();
    const { req } = await authedRequest(app);
    const human = await createAgent(app.db, {
      name: `human-lifecycle-${Date.now()}`,
      type: "human",
      displayName: "Human Lifecycle",
    });

    const suspendRes = await req("POST", `/api/v1/agents/${human.uuid}/suspend`);
    expect(suspendRes.statusCode).toBe(400);

    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, human.uuid));

    const reactivateRes = await req("POST", `/api/v1/agents/${human.uuid}/reactivate`);
    expect(reactivateRes.statusCode).toBe(400);

    const deleteRes = await req("DELETE", `/api/v1/agents/${human.uuid}`);
    expect(deleteRes.statusCode).toBe(400);

    const [row] = await app.db
      .select({ status: agents.status, name: agents.name })
      .from(agents)
      .where(eq(agents.uuid, human.uuid))
      .limit(1);
    expect(row).toEqual({ status: "suspended", name: human.name });
  });

  it("keeps human mirrors human when PATCH tries to type-flip before lifecycle calls", async () => {
    const app = getApp();
    const { req, ctx } = await authedRequest(app);

    const patchRes = await req("PATCH", `/api/v1/agents/${ctx.humanAgentUuid}`, {
      type: "agent",
      delegateMention: null,
    });
    expect(patchRes.statusCode).toBe(400);

    const suspendRes = await req("POST", `/api/v1/agents/${ctx.humanAgentUuid}/suspend`);
    expect(suspendRes.statusCode).toBe(400);

    const deleteRes = await req("DELETE", `/api/v1/agents/${ctx.humanAgentUuid}`);
    expect(deleteRes.statusCode).toBe(400);

    const [row] = await app.db
      .select({ type: agents.type, status: agents.status, name: agents.name })
      .from(agents)
      .where(eq(agents.uuid, ctx.humanAgentUuid))
      .limit(1);
    expect(row).toMatchObject({ type: "human", status: "active" });
    expect(row?.name).not.toBeNull();
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

  it("avatar serving stays proxied even in redirect download mode", async () => {
    const { createTestApp, workerObjectStorage: workerStorage } = await import("./helpers.js");
    const app = await createTestApp({
      objectStorage: workerStorage(),
      attachments: { downloadMode: "redirect" },
    });
    try {
      const ctx = await createAdminContext(app);
      const agent = await createAgent(app.db, {
        name: `avatar-proxy-pin-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: ctx.memberId,
        clientId: ctx.clientId,
      });
      const bytes = Buffer.from("avatar-proxy-pin");
      const upload = await app.inject({
        method: "PUT",
        url: `/api/v1/agents/${agent.uuid}/avatar`,
        headers: { authorization: `Bearer ${ctx.accessToken}`, "content-type": "image/png" },
        payload: bytes,
      });
      expect(upload.statusCode).toBe(200);

      // A presigned 302 would vary per request and defeat the immutable
      // browser cache this surface depends on — avatars always proxy.
      const serve = await app.inject({ method: "GET", url: `/api/v1/agents/${agent.uuid}/avatar` });
      expect(serve.statusCode).toBe(200);
      expect(serve.rawPayload.equals(bytes)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("serves uploaded agent avatars publicly and clears them through the manage route", async () => {
    const app = getApp();
    const { ctx } = await authedRequest(app);
    const agent = await createAgent(app.db, {
      name: `avatar-route-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const missing = await app.inject({ method: "GET", url: `/api/v1/agents/${agent.uuid}/avatar` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Avatar not set" });

    const badUpload = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.uuid}/avatar`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("avatar"),
    });
    expect(badUpload.statusCode).toBe(400);
    expect(badUpload.json<{ error: string }>().error).toContain("image/* Content-Type");

    // No body at all → no Content-Length → 411 (declared size is required
    // since the payload streams to object storage).
    const noLengthUpload = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.uuid}/avatar`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "content-type": "image/png",
      },
    });
    expect(noLengthUpload.statusCode).toBe(411);
    expect(noLengthUpload.json<{ error: string }>().error).toContain("Content-Length");

    const emptyImageUpload = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.uuid}/avatar`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "content-type": "image/png",
      },
      payload: Buffer.alloc(0),
    });
    expect(emptyImageUpload.statusCode).toBe(400);
    expect(emptyImageUpload.json<{ error: string }>().error).toContain("Avatar image payload is empty");

    const bytes = Buffer.from("avatar-png");
    const upload = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.uuid}/avatar`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "content-type": "image/png",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(200);
    const uploadBody = upload.json<{ avatarImageUrl: string }>();
    expect(uploadBody.avatarImageUrl).toMatch(new RegExp(`^/api/v1/agents/${agent.uuid}/avatar\\?v=\\d+$`));

    const download = await app.inject({ method: "GET", url: uploadBody.avatarImageUrl });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["cache-control"]).toBe("public, max-age=2592000, immutable");
    expect(String(download.headers.etag)).toMatch(/^"\d+"$/);
    expect(download.rawPayload.equals(bytes)).toBe(true);

    const clear = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agent.uuid}/avatar`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(clear.statusCode).toBe(204);

    const afterClear = await app.inject({ method: "GET", url: `/api/v1/agents/${agent.uuid}/avatar` });
    expect(afterClear.statusCode).toBe(404);
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
