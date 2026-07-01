import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { organizations } from "../db/schema/organizations.js";
import { findInstallationByGithubId, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Manual claim recovery. Binding is normally driven by the trusted,
 * HMAC-signed `installation.created` webhook (keyed by the admin-minted
 * install-intent). `/claim` is the recovery hatch when a row ended up
 * unbound; it authorizes on the trusted `installer_github_id` (the webhook
 * `sender`) — the caller may claim ONLY an installation they installed
 * themselves. No GitHub round-trip, no `organization:members:read` probe.
 */
describe("POST /api/v1/orgs/:orgId/github-app-installation/claim", () => {
  const getApp = useTestApp();

  // A First Tree admin with a linked GitHub identity (numeric id on
  // `auth_identities.identifier`, mirroring the OAuth callback). `/claim`
  // matches this id against the installation's `installer_github_id`.
  async function seedAdminWithGithubId(userGithubId: number): Promise<{ accessToken: string; organizationId: string }> {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `claim-${uuidv7().slice(0, 8)}` });
    await app.db.insert(authIdentities).values({
      id: uuidv7(),
      userId: admin.userId,
      provider: "github",
      identifier: String(userGithubId),
      email: null,
      verifiedAt: new Date(),
      metadata: { login: "claimer" },
    });
    return { accessToken: admin.accessToken, organizationId: admin.organizationId };
  }

  async function seedInstall(opts: {
    installationId: number;
    installerGithubId: number | null;
    boundTo?: string;
  }): Promise<void> {
    const app = getApp();
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: opts.installationId,
        accountType: "Organization",
        accountLogin: "acme",
        accountGithubId: 880_000 + opts.installationId,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
      ...(opts.installerGithubId !== null ? { installerGithubId: opts.installerGithubId } : {}),
      ...(opts.boundTo ? { hubOrganizationId: opts.boundTo } : {}),
    });
  }

  it("binds when the caller's GitHub id matches the installation's installer", async () => {
    const app = getApp();
    const userGithubId = 760_101;
    const { accessToken, organizationId } = await seedAdminWithGithubId(userGithubId);
    const installationId = 9_401;
    await seedInstall({ installationId, installerGithubId: userGithubId });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ bound: boolean }>().bound).toBe(true);
    expect((await findInstallationByGithubId(app.db, installationId))?.hubOrganizationId).toBe(organizationId);
  });

  it("403s when the caller didn't install it (installer id mismatch — hijack guard)", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubId(760_102);
    const installationId = 9_402;
    // Installed by a different GitHub identity.
    await seedInstall({ installationId, installerGithubId: 999_999 });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId },
    });
    expect(res.statusCode).toBe(403);
    expect((await findInstallationByGithubId(app.db, installationId))?.hubOrganizationId).toBeNull();
  });

  it("403s when the installation has no recorded installer (legacy / non-webhook row)", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubId(760_103);
    const installationId = 9_403;
    await seedInstall({ installationId, installerGithubId: null });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId },
    });
    expect(res.statusCode).toBe(403);
    expect((await findInstallationByGithubId(app.db, installationId))?.hubOrganizationId).toBeNull();
  });

  it("409s when the installer matches but the install is already bound to a different team", async () => {
    const app = getApp();
    const userGithubId = 760_104;
    const { accessToken, organizationId } = await seedAdminWithGithubId(userGithubId);
    const installationId = 9_404;
    const otherOrgId = uuidv7();
    await app.db.insert(organizations).values({ id: otherOrgId, name: `other-${otherOrgId}`, displayName: "Other" });
    await seedInstall({ installationId, installerGithubId: userGithubId, boundTo: otherOrgId });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s when there is no installation row with that id", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubId(760_105);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId: 9_405 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s when the caller has no GitHub identity on file", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noid-${uuidv7().slice(0, 8)}` });
    const installationId = 9_406;
    await seedInstall({ installationId, installerGithubId: 12_345 });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s on a malformed body", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubId(760_107);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
  });
});
