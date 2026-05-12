import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { organizations } from "../db/schema/organizations.js";
import { encryptValue } from "../services/crypto.js";
import {
  findInstallationByGithubId,
  findUnboundInstallationsByAccount,
  upsertInstallationFromMetadata,
} from "../services/github-app-installations.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Stub `globalThis.fetch` so the manual-claim endpoint's `/user/installations`
 * access check resolves deterministically (no network). Returns the supplied
 * ids; anything else falls through to the real fetch.
 */
function stubUserInstallations(ids: number[]) {
  const original = globalThis.fetch;
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  const spy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.github.com/user/installations")) {
      return new Response(JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return original(input, init);
  });
  globalThis.fetch = spy as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("findUnboundInstallationsByAccount", () => {
  const getApp = useTestApp();

  it("returns only unbound rows for the account, newest first", async () => {
    const app = getApp();
    const accountGithubId = 660_001;

    // Two unbound installs for this account, plus one bound row that must
    // not show up.
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: 9_001,
        accountType: "User",
        accountLogin: "acct",
        accountGithubId,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: 9_002,
        accountType: "User",
        accountLogin: "acct",
        accountGithubId,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });
    const orgId = uuidv7();
    await app.db.insert(organizations).values({ id: orgId, name: `unbound-${orgId}`, displayName: "Org" });
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: 9_003,
        accountType: "User",
        accountLogin: "acct",
        accountGithubId,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
      hubOrganizationId: orgId,
    });
    // Force 9_002 to be the newest.
    await app.db
      .update(githubAppInstallations)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(githubAppInstallations.installationId, 9_001));

    const rows = await findUnboundInstallationsByAccount(app.db, accountGithubId);
    expect(rows.map((r) => r.installationId)).toEqual([9_002, 9_001]);

    // A different account → nothing.
    expect(await findUnboundInstallationsByAccount(app.db, 999_999)).toHaveLength(0);
  });
});

describe("OAuth sign-in orphan-install reclaim (codex P1-5 + H1)", () => {
  const getApp = useTestApp();

  it("auto-claims the single unbound install matching the signing-in user's account", async () => {
    const app = getApp();
    const githubId = 661_001;
    const login = `orphan1-${uuidv7().slice(0, 6)}`;
    const installationId = 9_101;

    // First sign-in: mints the user + their personal team.
    await app.inject({ method: "GET", url: `/api/v1/auth/github/dev-callback?githubId=${githubId}&login=${login}` });

    // A stranded unbound install row whose account == this GitHub user.
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "User",
        accountLogin: login,
        accountGithubId: githubId,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });

    // Second sign-in: the reclaim sweep runs and binds the orphan.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=${githubId}&login=${login}`,
    });
    expect(res.statusCode).toBe(302);

    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).not.toBeNull();
    // It's the user's personal team — assert by cross-checking the org row's slug.
    const [org] = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, row?.hubOrganizationId ?? ""))
      .limit(1);
    expect(org?.name).toMatch(new RegExp(`^${login}`));
  });

  it("does NOT auto-claim when multiple unbound installs match the account", async () => {
    const app = getApp();
    const githubId = 661_002;
    const login = `orphan2-${uuidv7().slice(0, 6)}`;

    await app.inject({ method: "GET", url: `/api/v1/auth/github/dev-callback?githubId=${githubId}&login=${login}` });
    for (const id of [9_201, 9_202]) {
      await upsertInstallationFromMetadata(app.db, {
        installation: {
          id,
          accountType: "User",
          accountLogin: login,
          accountGithubId: githubId,
          permissions: {},
          events: [],
          suspendedAt: null,
        },
      });
    }

    await app.inject({ method: "GET", url: `/api/v1/auth/github/dev-callback?githubId=${githubId}&login=${login}` });

    for (const id of [9_201, 9_202]) {
      expect((await findInstallationByGithubId(app.db, id))?.hubOrganizationId).toBeNull();
    }
  });
});

describe("POST /api/v1/orgs/:orgId/github-app-installation/claim", () => {
  const getApp = useTestApp();

  async function seedAdminWithGithubToken(): Promise<{
    accessToken: string;
    organizationId: string;
    userId: string;
  }> {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `claim-${uuidv7().slice(0, 8)}` });
    // The claim endpoint reads the caller's stored GitHub token; createTestAdmin
    // doesn't make a github auth_identity, so add one with a stub encrypted token.
    await app.db.insert(authIdentities).values({
      id: uuidv7(),
      userId: admin.userId,
      provider: "github",
      identifier: `gh-${admin.userId.slice(0, 8)}`,
      email: null,
      verifiedAt: new Date(),
      metadata: { login: "claimer", accessToken: encryptValue("gho_stub", app.config.secrets.encryptionKey) },
    });
    return { accessToken: admin.accessToken, organizationId: admin.organizationId, userId: admin.userId };
  }

  it("binds an unbound installation the caller administers on GitHub", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubToken();
    const installationId = 9_301;
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "acme",
        accountGithubId: 880_001,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });

    const restore = stubUserInstallations([installationId]);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { installationId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ bound: boolean }>().bound).toBe(true);
    } finally {
      restore();
    }
    expect((await findInstallationByGithubId(app.db, installationId))?.hubOrganizationId).toBe(organizationId);
  });

  it("403s when the caller doesn't administer the installation on GitHub", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubToken();
    const installationId = 9_302;
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "other",
        accountGithubId: 880_002,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });
    const restore = stubUserInstallations([12_345]); // does not include installationId
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { installationId },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      restore();
    }
    expect((await findInstallationByGithubId(app.db, installationId))?.hubOrganizationId).toBeNull();
  });

  it("409s when the installation is already bound to a different Hub team", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubToken();
    const installationId = 9_303;
    const otherOrgId = uuidv7();
    await app.db.insert(organizations).values({ id: otherOrgId, name: `other-${otherOrgId}`, displayName: "Other" });
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "taken",
        accountGithubId: 880_003,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
      hubOrganizationId: otherOrgId,
    });
    const restore = stubUserInstallations([installationId]);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { installationId },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      restore();
    }
  });

  it("404s when there is no installation row with that id", async () => {
    const app = getApp();
    const { accessToken, organizationId } = await seedAdminWithGithubToken();
    const restore = stubUserInstallations([9_304]);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { installationId: 9_304 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      restore();
    }
  });

  it("403s when the caller has no GitHub token on file", async () => {
    const app = getApp();
    // createTestAdmin alone — no github auth_identity → no token.
    const admin = await createTestAdmin(app, { username: `notoken-${uuidv7().slice(0, 8)}` });
    const installationId = 9_305;
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "User",
        accountLogin: "x",
        accountGithubId: 880_005,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
    });
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
    const { accessToken, organizationId } = await seedAdminWithGithubToken();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${organizationId}/github-app-installation/claim`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { installationId: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
  });
});
