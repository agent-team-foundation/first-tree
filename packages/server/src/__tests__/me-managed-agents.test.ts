import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * PR-D §4.5.1 case (b): `GET /me/managed-agents` is the cross-org list of
 * every agent the caller manages. Powers CLI `agent list --remote`. Web
 * roster (`/admin/agents`) stays org-scoped.
 *
 * Threat model coverage: Bob in the same org A as Alice must NOT see Alice's
 * private agents through this endpoint, even though they share the org.
 * Cross-user isolation is enforced by `members.user_id` joining, not by org
 * scope.
 */
describe("PR-D: /me/managed-agents", () => {
  const getApp = useTestApp();

  it("returns every active agent across all orgs the caller manages", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Spin up a second org and a member entry for the same user.
    const orgBId = `org-mma-${crypto.randomUUID().slice(0, 8)}`;
    const memberBId = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx
        .insert(organizations)
        .values({ id: orgBId, name: `mma-${crypto.randomUUID().slice(0, 6)}`, displayName: "MMA Side" });
      const humanB = await createAgent(tx as unknown as typeof app.db, {
        name: `mma-human-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "MMA Human",
        managerId: memberBId,
        organizationId: orgBId,
      });
      await tx
        .insert(members)
        .values({ id: memberBId, userId: admin.userId, organizationId: orgBId, agentId: humanB.uuid, role: "member" });
    });

    // Pin one autonomous agent in org B owned by the same user.
    await createAgent(app.db, {
      name: `mma-bot-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "MMA Bot B",
      managerId: memberBId,
      organizationId: orgBId,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/managed-agents",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ organizationId: string; type: string }>>();
    const orgs = new Set(list.map((a) => a.organizationId));
    expect(orgs.has(admin.organizationId)).toBe(true);
    expect(orgs.has(orgBId)).toBe(true);
    // At minimum: the human agents seeded for both members + the autonomous bot above.
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it("does not leak agents managed by another user (cross-user isolation)", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app, { username: `mma-alice-${crypto.randomUUID().slice(0, 6)}` });
    const bob = await createTestAdmin(app, { username: `mma-bob-${crypto.randomUUID().slice(0, 6)}` });

    // Alice creates a private autonomous agent under her management.
    const alicePrivate = await createAgent(app.db, {
      name: `mma-priv-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Alice's Private Bot",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: "private",
    });

    // Bob fetches /me/managed-agents — Alice's agent must not be in the list.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/managed-agents",
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ uuid: string }>>();
    const uuids = new Set(list.map((a) => a.uuid));
    expect(uuids.has(alicePrivate.uuid)).toBe(false);
  });
});
