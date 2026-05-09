import { describe, expect, it } from "vitest";
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

  /** Attach `userId` to a fresh side-org as `role`. */
  async function attachMember(
    app: ReturnType<typeof getApp>,
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
    const body = res.json() as Array<{ id: string; userId: string }>;
    const ids = body.map((c) => c.id).sort();
    expect(ids).toEqual([a.clientId, aSecond].sort());
    expect(ids).not.toContain(b.clientId);
    for (const row of body) expect(row.userId).toBe(a.userId);
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

  it("requires authentication", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/me/clients" });
    expect(res.statusCode).toBe(401);
  });
});
