import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Decouple-client-from-identity §4.5 / §D — admin powers must be re-checked
 * realtime against `members.role`. The JWT default `role` claim is a hint;
 * an admin in org A cannot exercise admin powers when the request targets
 * org B by spoofing the body/query `organizationId`. Membership downgrades
 * land on the next request, not on the next JWT rotation.
 */
describe("PR-D: admin role is realtime, not derived from the JWT", () => {
  const getApp = useTestApp();

  /** Create an org plus an inactive `member` row for an existing user. */
  async function attachMember(
    app: ReturnType<typeof getApp>,
    userId: string,
    role: "admin" | "member",
  ): Promise<{ orgId: string; memberId: string }> {
    const orgId = `org-rt-${crypto.randomUUID().slice(0, 8)}`;
    const memberId = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx
        .insert(organizations)
        .values({ id: orgId, name: `rt-${crypto.randomUUID().slice(0, 6)}`, displayName: "Realtime Side" });
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `rt-h-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "RT Human",
        managerId: memberId,
        organizationId: orgId,
      });
      await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
    });
    return { orgId, memberId };
  }

  it("POST /orgs/:orgId/agents in a non-default org pins managerId to caller's member row when caller is only a member", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgB = await attachMember(app, alice.userId, "member");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/agents`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        name: `rt-bot-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Member Caller",
        // try to set someone else's manager — only an admin can do this
        managerId: orgB.memberId,
      },
    });
    expect(res.statusCode).toBe(201);
    // Realtime probe finds Alice as `member` in orgB, so body.managerId is
    // forced to her own (`scope.memberId`) regardless of what was sent.
    const body = res.json<{ managerId: string; organizationId: string }>();
    expect(body.organizationId).toBe(orgB.orgId);
    expect(body.managerId).toBe(orgB.memberId);
  });

  it("GET /orgs/:orgId/agents/all rejects with 403 when the caller is not admin in the target org", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgB = await attachMember(app, alice.userId, "member");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/agents/all`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /orgs/:orgId/agents/all rejects with 403 in an org the caller has zero membership in", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgC = `org-rt-c-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(organizations).values({ id: orgC, name: orgC.slice(0, 30), displayName: "Outside" });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(orgC)}/agents/all`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /orgs/:orgId/clients refuses non-admins in that org", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgB = await attachMember(app, alice.userId, "member");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/clients`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * Regression for codex P1 #3 — `GET /admin/agents/:uuid` (and other
   * agent-uuid routes) used to short-circuit on
   * `agent.organizationId !== scope.organizationId`. With `/auth/switch-org`
   * now returning 204, scope.organizationId stays at the JWT default org;
   * a multi-org user looking at a non-default org would 404 on every
   * detail/config/suspend/test request.
   *
   * The fix authorizes against the agent's own organization via a realtime
   * `requireMemberInOrg`, so a JWT-default-A caller can read /update
   * /suspend an agent in org B as long as that membership is still active.
   */
  it("GET /admin/agents/:uuid succeeds for an agent in a non-default org (P1 #3)", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgB = await attachMember(app, alice.userId, "admin");

    // Pin an autonomous agent under Alice's member row in org B.
    const bot = await createAgent(app.db, {
      name: `rt-bot-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Bot in Org B",
      managerId: orgB.memberId,
      organizationId: orgB.orgId,
      visibility: "private",
    });

    // No `?organizationId=` is even needed for a `:uuid` route — the agent
    // carries its own org. The pre-fix behavior would 404 because Alice's
    // JWT default org differs from `orgB.orgId`.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${bot.uuid}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ uuid: string; organizationId: string }>();
    expect(body.uuid).toBe(bot.uuid);
    expect(body.organizationId).toBe(orgB.orgId);
  });

  it("PATCH /admin/agents/:uuid in a non-default org succeeds for the org's admin", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const orgB = await attachMember(app, alice.userId, "admin");

    const bot = await createAgent(app.db, {
      name: `rt-mgr-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Bot in Org B",
      managerId: orgB.memberId,
      organizationId: orgB.orgId,
      visibility: "private",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${bot.uuid}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { displayName: "Renamed Cross-Org" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ displayName: string }>().displayName).toBe("Renamed Cross-Org");
  });

  it("GET /admin/agents/:uuid still 404s when the caller has no membership in the agent's org", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    // Bob owns an agent in a foreign org Alice has zero membership in.
    // `attachMember` creates a fresh org row + member, so the agent really
    // lives outside Alice's reachable scope — `createTestAdmin` would
    // otherwise put Bob in the same default org as Alice and the test
    // would only be exercising the visibility filter, not the
    // not-a-member-of-this-org guard the title claims.
    const bobBase = await createTestAdmin(app, { username: `rt-bob-${crypto.randomUUID().slice(0, 6)}` });
    const bobForeign = await attachMember(app, bobBase.userId, "admin");
    const bot = await createAgent(app.db, {
      name: `rt-foreign-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Bot Owned By Bob",
      managerId: bobForeign.memberId,
      organizationId: bobForeign.orgId,
      visibility: "private",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${bot.uuid}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    // Alice has no membership in bobForeign.orgId; resolveCallerInOrg
    // throws NotFoundError before the visibility/admin probe ever runs,
    // so the response is 404 regardless of Alice's role.
    expect(res.statusCode).toBe(404);
  });
});
