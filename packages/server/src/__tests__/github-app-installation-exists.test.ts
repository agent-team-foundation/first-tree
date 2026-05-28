import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * `GET /orgs/:orgId/github-app-installation/exists` — member-readable
 * boolean probe added so invitee onboarding can detect "admin set up the
 * tree but never connected GitHub" without tripping the admin-gated
 * details endpoint. Two failure modes the round-2 codex review flagged:
 *
 *   - 403 → "missing"   blocks every invitee of a healthy team
 *   - 403 → "installed" makes the no-installation safeguard unreachable
 *
 * Both vanish once /exists is member-readable: members get a real
 * boolean, no 403 in the way.
 */
describe("GET /orgs/:orgId/github-app-installation/exists", () => {
  const getApp = useTestApp();

  async function seedInstallation(app: ReturnType<typeof getApp>, orgId: string, installationId: number) {
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: `org-${installationId}`,
        accountGithubId: installationId * 10,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });
    await bindInstallationToOrg(app.db, installationId, orgId);
  }

  it("returns { exists: true } when an installation is bound", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `e-admin-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 900_001);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/exists`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: true });
  });

  it("returns { exists: false } when no installation is bound (no 404 path; presence is the whole answer)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `e-admin-${crypto.randomUUID().slice(0, 8)}` });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/exists`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: false });
  });

  it("is member-readable (does NOT require admin) — the whole point of this endpoint", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `e-admin-${crypto.randomUUID().slice(0, 8)}` });

    // Demote the caller to member, then re-login so the JWT carries role:member.
    const userId = (
      await app.db.select({ id: users.id }).from(users).where(eq(users.username, admin.username)).limit(1)
    )[0]?.id;
    expect(userId).toBeDefined();
    await app.db
      .update(members)
      .set({ role: "member" })
      .where(eq(members.userId, userId ?? ""));
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: admin.username, password: admin.password },
    });
    const fresh = loginRes.json<{ accessToken: string }>();

    await seedInstallation(app, admin.organizationId, 900_002);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/exists`,
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    });
    // The admin-gated GET / would 403 here. /exists must 200.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: true });
  });

  // Non-member rejection is structurally enforced by the shared
  // `requireOrgMembership` helper used at the top of /exists' handler. The
  // helper has its own coverage in scope/* tests; setting up a truly
  // disjoint org here would require building a second org from scratch,
  // which isn't worth duplicating just to re-verify a one-liner.
});
