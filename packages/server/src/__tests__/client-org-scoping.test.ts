import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { organizations } from "../db/schema/organizations.js";
import { ForbiddenError } from "../errors.js";
import { createAgent } from "../services/agent.js";
import { assertClientOwner, registerClient } from "../services/client.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Connection-vs-identity decoupling (decouple-client-from-identity §4.1):
 * a client is owned by exactly one user and **carries no org binding** at
 * the read path. The legacy `clients.organization_id` column survives as a
 * vestigial NOT NULL placeholder but is no longer consumed.
 *
 * These tests pin the new contract:
 *   1. Re-registering the same clientId under the same user across
 *      organizations is accepted and the placeholder org does not drift.
 *   2. `assertClientOwner` only compares user_id; cross-user access is
 *      refused (irrespective of org).
 *   3. `resolveAgentClient` (in agent service) only checks ownership by
 *      user_id; cross-org pinning under the same user is allowed.
 */
describe("clients: user-only ownership", () => {
  const getApp = useTestApp();

  async function createSecondOrgId(app: Awaited<ReturnType<typeof getApp>>): Promise<string> {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [row] = await app.db
      .insert(organizations)
      .values({ id: `org-${suffix}`, name: `other-${suffix}`, displayName: `Other ${suffix}` })
      .returning({ id: organizations.id });
    if (!row) throw new Error("failed to seed secondary organization");
    return row.id;
  }

  it("re-register under a different org is accepted; placeholder org does not drift", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `xorg-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrgId = await createSecondOrgId(app);

    const clientId = `cli-xorg-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test",
    });

    // Same user, same clientId, different org placeholder → accepted.
    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: otherOrgId,
      instanceId: "test",
    });

    // Vestigial placeholder column unchanged on conflict (sticks to first insert).
    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.organizationId).toBe(admin.organizationId);
    expect(row?.userId).toBe(admin.userId);
  });

  it("first register stamps the placeholder organizationId", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `stamp-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `cli-stamp-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test",
    });

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.organizationId).toBe(admin.organizationId);
    expect(row?.userId).toBe(admin.userId);
  });

  it("assertClientOwner refuses access from a different user", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app, { username: `iso-a-${crypto.randomUUID().slice(0, 8)}` });
    const bob = await createTestAdmin(app, { username: `iso-b-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `cli-iso-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, {
      clientId,
      userId: alice.userId,
      organizationId: alice.organizationId,
      instanceId: "test",
    });

    // Owner can read.
    await expect(assertClientOwner(app.db, clientId, { userId: alice.userId })).resolves.toBeUndefined();

    // Different user — even within the same org — sees 404.
    await expect(assertClientOwner(app.db, clientId, { userId: bob.userId })).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("createAgent refuses to pin an agent to a client owned by a different user", async () => {
    // Cross-user defense remains: a client is owned by a user; pinning by
    // another user's manager fails. (Cross-org under the same user is allowed
    // and covered by ws-bind-multi-org.test.ts in PR-B.)
    const app = getApp();
    const alice = await createTestAdmin(app, { username: `pin-a-${crypto.randomUUID().slice(0, 8)}` });
    const bob = await createTestAdmin(app, { username: `pin-b-${crypto.randomUUID().slice(0, 8)}` });

    const aliceClient = `cli-cross-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: aliceClient,
      userId: alice.userId,
      organizationId: alice.organizationId,
      status: "connected",
    });

    // bob.memberId belongs to bob.userId; client is alice's.
    await expect(
      createAgent(app.db, {
        name: `cross-user-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "autonomous_agent",
        displayName: "Cross-user Agent",
        managerId: bob.memberId,
        clientId: aliceClient,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
