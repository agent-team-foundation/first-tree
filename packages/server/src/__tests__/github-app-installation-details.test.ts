import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("GET /orgs/:orgId/github-app-installation", () => {
  const getApp = useTestApp();

  async function seedInstallation(
    app: ReturnType<typeof getApp>,
    orgId: string,
    installationId: number,
    opts: { accountType?: "Organization" | "User" } = {},
  ) {
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: opts.accountType ?? "Organization",
        accountLogin: `org-${installationId}`,
        accountGithubId: installationId * 10,
        permissions: { contents: "read" },
        events: ["issues"],
        suspendedAt: null,
      },
    });
    await bindInstallationToOrg(app.db, installationId, orgId);
  }

  async function demoteAndLogin(app: ReturnType<typeof getApp>, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
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
    return loginRes.json<{ accessToken: string }>().accessToken;
  }

  it("is member-readable so Settings GitHub can show read-only connection details", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `gh-member-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 901_001);
    const memberToken = await demoteAndLogin(app, admin);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation`,
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      installationId: 901_001,
      accountLogin: "org-901001",
      accountType: "Organization",
      permissions: { contents: "read" },
      events: ["issues"],
    });
  });

  it("returns 404 when no installation is bound", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `gh-none-${crypto.randomUUID().slice(0, 8)}` });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain("No GitHub App installation");
  });

  it("uses the user installation manage URL for personal-account installs", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `gh-user-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 901_002, { accountType: "User" });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ manageUrl: string }>().manageUrl).toBe("https://github.com/settings/installations/901002");
  });
});
