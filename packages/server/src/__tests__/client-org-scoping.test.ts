import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { ClientOrgMismatchError, ForbiddenError } from "../errors.js";
import { createAgent } from "../services/agent.js";
import { assertClientOwner, registerClient } from "../services/client.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Multi-tenancy hardening: a client is bound to exactly one org for its
 * lifetime. These tests cover the three scenarios that can arise when a user
 * with memberships in two orgs reuses a clientId:
 *
 *   1. Re-registering the same clientId under the same user + same org =
 *      idempotent refresh (already covered by client-register-claim.test).
 *   2. Re-registering the same clientId under the same user + a DIFFERENT
 *      org = CLIENT_ORG_MISMATCH. The CLI rotates the local clientId in
 *      response.
 *   3. Read paths (`assertClientOwner`) filter by the caller's org, so a
 *      cross-org admin cannot touch a client that belongs to a peer org.
 */
describe("clients: cross-org isolation", () => {
  const getApp = useTestApp();

  async function createSecondOrg(app: Awaited<ReturnType<typeof getApp>>): Promise<string> {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [row] = await app.db
      .insert(organizations)
      .values({ id: `org-${suffix}`, name: `other-${suffix}`, displayName: `Other ${suffix}` })
      .returning({ id: organizations.id });
    if (!row) throw new Error("failed to seed secondary organization");
    return row.id;
  }

  it("registerClient refuses to move a client to a different org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `xorg-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrgId = await createSecondOrg(app);

    const clientId = `cli-xorg-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test",
    });

    // Same user, same clientId, different org → mismatch.
    await expect(
      registerClient(app.db, {
        clientId,
        userId: admin.userId,
        organizationId: otherOrgId,
        instanceId: "test",
      }),
    ).rejects.toBeInstanceOf(ClientOrgMismatchError);

    // Row org unchanged.
    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.organizationId).toBe(admin.organizationId);
  });

  it("first register stamps organizationId from the caller's scope", async () => {
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

  it("assertClientOwner hides a client from an admin in a different org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `iso-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrgId = await createSecondOrg(app);

    const clientId = `cli-iso-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test",
    });

    // Owner can read.
    await expect(
      assertClientOwner(app.db, clientId, {
        userId: admin.userId,
        organizationId: admin.organizationId,
        role: "admin",
      }),
    ).resolves.toBeUndefined();

    // An admin scoped to another org sees 404 — no cross-org leak.
    await expect(
      assertClientOwner(app.db, clientId, {
        userId: "other-admin-user-id",
        organizationId: otherOrgId,
        role: "admin",
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("createAgent refuses to pin an agent to a client in a different org", async () => {
    // Rule R-RUN applied at creation time: `resolveAgentClient` now compares
    // `clients.organization_id` to `members.organization_id` and refuses the
    // create. Without this, an admin in org A holding credentials for a client
    // that was (historically) claimed under another org could smuggle an agent
    // into that other org's tenant via the pin.
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `pin-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrgId = await createSecondOrg(app);

    // Seed a client that lives in the *other* org but happens to share the same
    // owning user (simulates a user who is a member of both orgs and registered
    // a client in the other one first).
    const crossOrgClientId = `cli-cross-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: crossOrgClientId,
      userId: admin.userId,
      organizationId: otherOrgId,
      status: "connected",
    });

    // Manager belongs to admin.organizationId; client belongs to otherOrgId.
    // Expect ForbiddenError, *not* silent success that would strand the agent.
    await expect(
      createAgent(app.db, {
        name: `cross-org-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "autonomous_agent",
        displayName: "Cross-org Agent",
        managerId: admin.memberId,
        clientId: crossOrgClientId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Membership unaffected: the failing create must not have side-effected
    // the members table.
    const [mgrMember] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    expect(mgrMember?.organizationId).toBe(admin.organizationId);
  });
});
