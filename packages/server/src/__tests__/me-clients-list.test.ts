import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, seedClient, useTestApp } from "./helpers.js";

/**
 * `GET /api/v1/me/clients` — Class A user-scope listing. A client is owned
 * by exactly one user (`clients.user_id`); the same machine carries agents
 * across every org the user belongs to, so the list is intentionally
 * org-agnostic. The org-admin audit view (`/orgs/:orgId/clients`) is a
 * separate route and is not exercised here.
 */
describe("GET /me/clients", () => {
  const getApp = useTestApp();
  const getSemverApp = useTestApp({ commandVersion: "0.6.0" });
  const getProdApp = useTestApp({ channel: "prod", commandVersion: "0.6.0" });

  it("returns only the caller's own clients", async () => {
    const app = getApp();
    const a = await createAdminContext(app);
    const b = await createAdminContext(app);

    const aSecond = await seedClient(app, a.userId, a.organizationId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ binName: string; id: string; userId: string }>;
    const ids = body.map((c) => c.id).sort();
    expect(ids).toEqual([a.clientId, aSecond].sort());
    expect(ids).not.toContain(b.clientId);
    for (const row of body) {
      expect(row.userId).toBe(a.userId);
      expect(row.binName).toBe("first-tree-dev");
    }
  });

  it("returns the caller's clients across all their orgs", async () => {
    // Core UX promise of the fix: switching the active team (or being only a
    // member rather than an admin in some teams) must not change the set of
    // clients the user sees in Settings → Computers.
    const app = getApp();
    const a = await createAdminContext(app); // admin in orgA + a client there
    const orgB = await attachMember(app, a.userId, "member"); // member in orgB + a client there
    const aSecondInOrgB = await seedClient(app, a.userId, orgB.orgId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string }>;
    const ids = body.map((c) => c.id).sort();
    // Both clients show up despite the second one being seeded against an
    // org where the caller is a non-admin member — proving the route is
    // user-scope, not org-admin-scope.
    expect(ids).toEqual([a.clientId, aSecondInOrgB].sort());
  });

  it("hides retired clients from the default caller list", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const retiredClientId = await seedClient(app, ctx.userId, ctx.organizationId);
    await app.db
      .update(clients)
      .set({ retiredAt: new Date(), status: "disconnected" })
      .where(eq(clients.id, retiredClientId));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string }>;
    expect(body.map((c) => c.id)).toContain(ctx.clientId);
    expect(body.map((c) => c.id)).not.toContain(retiredClientId);
  });

  it("exposes retired status on the owner single-client route", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await app.db
      .update(clients)
      .set({ retiredAt: new Date(), status: "disconnected" })
      .where(eq(clients.id, ctx.clientId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/clients/${encodeURIComponent(ctx.clientId)}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("retired");
  });

  it("rejects mutation endpoints on retired clients", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const retiredAt = new Date();
    await app.db
      .update(clients)
      .set({ retiredAt, status: "disconnected", instanceId: null })
      .where(eq(clients.id, ctx.clientId));

    const headers = { authorization: `Bearer ${ctx.accessToken}` };
    const capability = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/${encodeURIComponent(ctx.clientId)}/capabilities`,
      headers,
      payload: {
        capabilities: { "claude-code": { state: "ok", available: true, detectedAt: new Date().toISOString() } },
      },
    });
    const runtimeAuth = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${encodeURIComponent(ctx.clientId)}/runtime-auth/start`,
      headers,
      payload: { provider: "claude-code" },
    });
    const disconnect = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${encodeURIComponent(ctx.clientId)}/disconnect`,
      headers,
    });

    expect(capability.statusCode).toBe(410);
    expect(runtimeAuth.statusCode).toBe(410);
    expect(disconnect.statusCode).toBe(410);
    const [row] = await app.db.select().from(clients).where(eq(clients.id, ctx.clientId));
    expect(row?.retiredAt?.toISOString()).toBe(retiredAt.toISOString());
    expect(row?.status).toBe("disconnected");
    expect(row?.instanceId).toBeNull();
  });

  it("includes the server command version hint only when the client is behind on dev/staging", async () => {
    const app = getSemverApp();
    const ctx = await createAdminContext(app);
    await app.db.update(clients).set({ sdkVersion: "0.5.0" }).where(eq(clients.id, ctx.clientId));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; serverCommandVersion?: string }>;
    const row = body.find((c) => c.id === ctx.clientId);
    expect(row?.serverCommandVersion).toBe("0.6.0");

    await app.db.update(clients).set({ sdkVersion: "0.6.0" }).where(eq(clients.id, ctx.clientId));

    const freshRes = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(freshRes.statusCode).toBe(200);
    const freshBody = freshRes.json() as Array<{ id: string; serverCommandVersion?: string }>;
    const freshRow = freshBody.find((c) => c.id === ctx.clientId);
    expect(freshRow?.serverCommandVersion).toBeUndefined();
  });

  it("omits the server command version hint in prod", async () => {
    const app = getProdApp();
    const ctx = await createAdminContext(app);
    await app.db.update(clients).set({ sdkVersion: "0.5.0" }).where(eq(clients.id, ctx.clientId));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; serverCommandVersion?: string }>;
    const row = body.find((c) => c.id === ctx.clientId);
    expect(row?.serverCommandVersion).toBeUndefined();
  });

  it("requires authentication", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/me/clients" });
    expect(res.statusCode).toBe(401);
  });

  /**
   * Computer status pill derivation (web) needs to know if any runtime
   * capability is `ok` to distinguish "Ready" from "Setup incomplete". The
   * full capability snapshot lives at `clients.metadata.capabilities`; the
   * list response surfaces it so the pill can be computed client-side
   * without fanning out one `GET /clients/:id` per row.
   */
  it("includes the reported capabilities snapshot in each row", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);

    const capabilities = {
      "claude-code": {
        state: "ok",
        available: true,
        sdkVersion: "0.8.1",
        detectedAt: new Date().toISOString(),
      },
      codex: {
        state: "missing",
        available: false,
        sdkVersion: null,
        detectedAt: new Date().toISOString(),
      },
    } as const;

    await app.db.update(clients).set({ metadata: { capabilities } }).where(eq(clients.id, ctx.clientId));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      id: string;
      capabilities: Record<string, { state: string; sdkVersion: string | null }>;
    }>;
    const row = body.find((c) => c.id === ctx.clientId);
    expect(row).toBeDefined();
    expect(row?.capabilities["claude-code"]?.state).toBe("ok");
    expect(row?.capabilities["claude-code"]?.sdkVersion).toBe("0.8.1");
    expect(row?.capabilities.codex?.state).toBe("missing");
  });

  /**
   * Brand-new clients that have never run the capability probe land in
   * the DB with `metadata = NULL` (or no `capabilities` sub-key). The
   * response must still expose `capabilities` as an empty object — never
   * `undefined` / `null` — so the web pill derivation can treat the value
   * as a stable map without conditional access.
   */
  it("returns an empty capabilities object when the client has never reported any", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    // seedClient leaves metadata NULL; do not touch it.

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; capabilities: Record<string, unknown> }>;
    const row = body.find((c) => c.id === ctx.clientId);
    expect(row).toBeDefined();
    expect(row?.capabilities).toEqual({});
  });
});

/** Attach `userId` to a fresh side-org as `role`. */
async function attachMember(
  app: FastifyInstance,
  userId: string,
  role: "admin" | "member",
): Promise<{ orgId: string; memberId: string }> {
  const orgId = `org-mc-${crypto.randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  await app.db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: orgId, name: `mc-${crypto.randomUUID().slice(0, 6)}`, displayName: "Side Org" });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `mc-h-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Side Human",
      managerId: memberId,
      organizationId: orgId,
    });
    await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
  });
  return { orgId, memberId };
}

/**
 * Admin team listing — same capability surfacing as `/me/clients`, but for
 * cross-user audit view. The pill derivation is shared between member
 * self-view and admin team-view; both endpoints must carry the same
 * payload shape. The admin's own client is part of the team list (joined
 * via `members.userId = clients.userId`), so we cover the wiring without
 * needing a separate teammate row.
 */
describe("GET /orgs/:orgId/clients (admin team view)", () => {
  const getApp = useTestApp();
  const getSemverApp = useTestApp({ commandVersion: "0.6.0" });

  it("includes capabilities for clients in the team listing", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    const capabilities = {
      "claude-code": {
        state: "ok",
        available: true,
        sdkVersion: "0.8.1",
        detectedAt: new Date().toISOString(),
      },
    } as const;

    await app.db.update(clients).set({ metadata: { capabilities } }).where(eq(clients.id, admin.clientId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/clients`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      id: string;
      capabilities: Record<string, { state: string; sdkVersion: string | null }>;
    }>;
    const row = body.find((c) => c.id === admin.clientId);
    expect(row).toBeDefined();
    expect(row?.capabilities["claude-code"]?.state).toBe("ok");
    expect(row?.capabilities["claude-code"]?.sdkVersion).toBe("0.8.1");
  });

  it("counts only agents in the requested org for team listing", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const sideOrg = await attachMember(app, admin.userId, "member");

    await createAgent(app.db, {
      name: `org-a-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Org A Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    await createAgent(app.db, {
      name: `org-b-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Org B Agent 1",
      managerId: sideOrg.memberId,
      clientId: admin.clientId,
    });
    await createAgent(app.db, {
      name: `org-b-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Org B Agent 2",
      managerId: sideOrg.memberId,
      clientId: admin.clientId,
    });

    const teamRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/clients`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(teamRes.statusCode).toBe(200);
    const teamBody = teamRes.json() as Array<{ id: string; agentCount: number }>;
    expect(teamBody.find((c) => c.id === admin.clientId)?.agentCount).toBe(1);

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json() as Array<{ id: string; agentCount: number }>;
    expect(meBody.find((c) => c.id === admin.clientId)?.agentCount).toBe(3);
  });

  it("hides retired clients from the default team listing", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    await app.db
      .update(clients)
      .set({ retiredAt: new Date(), status: "disconnected" })
      .where(eq(clients.id, admin.clientId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/clients`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string }>;
    expect(body.map((c) => c.id)).not.toContain(admin.clientId);
  });

  it("includes server command version for stale clients in the team listing", async () => {
    const app = getSemverApp();
    const admin = await createAdminContext(app);
    await app.db.update(clients).set({ sdkVersion: "0.5.0" }).where(eq(clients.id, admin.clientId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/clients`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; serverCommandVersion?: string }>;
    const row = body.find((c) => c.id === admin.clientId);
    expect(row).toBeDefined();
    expect(row?.serverCommandVersion).toBe("0.6.0");
  });

  it("returns an empty capabilities object for clients that have not reported any", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    // seedClient (via createAdminContext) leaves metadata NULL.

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/clients`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; capabilities: Record<string, unknown> }>;
    const row = body.find((c) => c.id === admin.clientId);
    expect(row).toBeDefined();
    expect(row?.capabilities).toEqual({});
  });
});
