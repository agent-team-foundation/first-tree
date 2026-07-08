import type { GithubAppConnectPanelOutput } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { findInstallationByGithubId, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Connect-panel suite — the unified connect model's whole authorization
 * story is "First Tree team admin + the caller's GitHub id equals the
 * installation's webhook-recorded requester or installer". Note what is
 * deliberately ABSENT here compared to the retired `/claim` tests: no
 * `globalThis.fetch` stub, because no panel endpoint talks to GitHub.
 */
describe("GET/POST /api/v1/orgs/:orgId/github-app-installation connect panel", () => {
  const getApp = useTestApp();

  /** Admin + a linked GitHub identity (numeric id), no GitHub token needed. */
  async function seedAdminWithGithubIdentity(opts: { githubId?: number } = {}) {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `connect-${uuidv7().slice(0, 8)}` });
    const githubId = opts.githubId ?? Math.floor(700_000 + Math.random() * 99_999);
    await app.db.insert(authIdentities).values({
      id: uuidv7(),
      userId: admin.userId,
      provider: "github",
      identifier: String(githubId),
      email: null,
      verifiedAt: new Date(),
      metadata: { login: "connector" },
    });
    return { ...admin, githubId };
  }

  async function seedInstallation(opts: {
    installationId: number;
    accountLogin: string;
    orgId?: string | null;
    installerGithubId?: number;
    requesterGithubId?: number;
    suspended?: boolean;
  }) {
    const app = getApp();
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: opts.installationId,
        accountType: "Organization",
        accountLogin: opts.accountLogin,
        accountGithubId: 800_000 + opts.installationId,
        permissions: {},
        events: [],
        suspendedAt: opts.suspended ? new Date().toISOString() : null,
      },
      ...(opts.orgId ? { hubOrganizationId: opts.orgId } : {}),
      ...(opts.installerGithubId !== undefined ? { installerGithubId: opts.installerGithubId } : {}),
      ...(opts.requesterGithubId !== undefined ? { requesterGithubId: opts.requesterGithubId } : {}),
    });
  }

  async function seedOtherTeam(displayName: string): Promise<string> {
    const app = getApp();
    const id = uuidv7();
    await app.db.insert(organizations).values({ id, name: `other-${id.slice(0, 13)}`, displayName });
    return id;
  }

  // ── GET /connect-panel ────────────────────────────────────────────────

  it("labels the caller's installations connectable / connected-here / connected-elsewhere and hides unrelated ones", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    const otherOrgId = await seedOtherTeam("Other Team");

    // Association covers BOTH anchors: requester on one row, installer on
    // another — either alone must surface the row.
    await seedInstallation({ installationId: 501, accountLogin: "free-org", requesterGithubId: admin.githubId });
    await seedInstallation({
      installationId: 502,
      accountLogin: "mine-org",
      orgId: admin.organizationId,
      installerGithubId: admin.githubId,
    });
    await seedInstallation({
      installationId: 503,
      accountLogin: "taken-org",
      orgId: otherOrgId,
      requesterGithubId: admin.githubId,
    });
    // Unrelated installation — someone else's ids; must not appear.
    await seedInstallation({
      installationId: 504,
      accountLogin: "stranger-org",
      installerGithubId: 1,
      requesterGithubId: 2,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect-panel`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<GithubAppConnectPanelOutput>();
    const byId = new Map(body.installations.map((i) => [i.installationId, i]));
    expect(byId.size).toBe(3);
    expect(byId.get(501)).toMatchObject({ status: "connectable", accountLogin: "free-org", connectedTeamName: null });
    expect(byId.get(502)).toMatchObject({ status: "connected-here", connectedTeamName: null });
    expect(byId.get(503)).toMatchObject({ status: "connected-elsewhere", connectedTeamName: "Other Team" });
    expect(byId.has(504)).toBe(false);
  });

  it("returns an empty list (not an error) when the caller has no GitHub identity on file", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noident-${uuidv7().slice(0, 8)}` });
    await seedInstallation({ installationId: 511, accountLogin: "some-org", installerGithubId: 42 });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect-panel`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<GithubAppConnectPanelOutput>().installations).toEqual([]);
  });

  it("403s the panel for a non-admin member", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    await app.db.update(members).set({ role: "member" }).where(eq(members.userId, admin.userId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect-panel`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── POST /connect ─────────────────────────────────────────────────────

  it("connects an unbound installation the caller requested (zero GitHub API involvement)", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    await seedInstallation({ installationId: 521, accountLogin: "acme", requesterGithubId: admin.githubId });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 521 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ connected: boolean }>().connected).toBe(true);
    expect((await findInstallationByGithubId(app.db, 521))?.hubOrganizationId).toBe(admin.organizationId);
  });

  it("403s connect when the caller is neither requester nor installer", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    await seedInstallation({ installationId: 522, accountLogin: "victim", installerGithubId: 1, requesterGithubId: 2 });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 522 },
    });
    expect(res.statusCode).toBe(403);
    expect((await findInstallationByGithubId(app.db, 522))?.hubOrganizationId).toBeNull();
  });

  it("403s connect when the caller has no GitHub identity on file", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noident2-${uuidv7().slice(0, 8)}` });
    await seedInstallation({ installationId: 523, accountLogin: "acme2", installerGithubId: 42 });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 523 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409s connect when the installation is already connected to another team (1:1)", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    const otherOrgId = await seedOtherTeam("Holder Team");
    await seedInstallation({
      installationId: 524,
      accountLogin: "taken",
      orgId: otherOrgId,
      requesterGithubId: admin.githubId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 524 },
    });
    expect(res.statusCode).toBe(409);
    expect((await findInstallationByGithubId(app.db, 524))?.hubOrganizationId).toBe(otherOrgId);
  });

  it("409s connect when this team already holds a different installation (1:1, other direction)", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    await seedInstallation({
      installationId: 525,
      accountLogin: "held",
      orgId: admin.organizationId,
      installerGithubId: admin.githubId,
    });
    await seedInstallation({ installationId: 526, accountLogin: "second", requesterGithubId: admin.githubId });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 526 },
    });
    expect(res.statusCode).toBe(409);
    expect((await findInstallationByGithubId(app.db, 526))?.hubOrganizationId).toBeNull();
  });

  it("404s connect for an unknown installation id", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 599 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s connect on a malformed body", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── POST /disconnect ──────────────────────────────────────────────────

  it("disconnects the team's installation, keeping the row reconnectable (no uninstall)", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    await seedInstallation({
      installationId: 531,
      accountLogin: "acme",
      orgId: admin.organizationId,
      requesterGithubId: admin.githubId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/disconnect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ disconnected: boolean; installationId: number }>()).toMatchObject({
      disconnected: true,
      installationId: 531,
    });
    // Row survives unbound with its anchors intact — reconnect works.
    const row = await findInstallationByGithubId(app.db, 531);
    expect(row).toBeTruthy();
    expect(row?.hubOrganizationId).toBeNull();
    expect(row?.requesterGithubId).toBe(admin.githubId);

    const reconnect = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/connect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { installationId: 531 },
    });
    expect(reconnect.statusCode).toBe(200);
    expect((await findInstallationByGithubId(app.db, 531))?.hubOrganizationId).toBe(admin.organizationId);
  });

  it("404s disconnect when the team has no bound installation", async () => {
    const app = getApp();
    const admin = await seedAdminWithGithubIdentity();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/disconnect`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
