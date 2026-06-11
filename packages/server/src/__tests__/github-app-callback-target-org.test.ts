import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { findInstallationByGithubId, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { ensureMembership } from "../services/membership.js";
import { OAUTH_STATE_COOKIE, signOAuthState } from "../services/oauth-state.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";

/**
 * Throwaway RSA-2048 keypair so `createAppJwt` can actually sign during
 * the integration tests (the helper's default PEM is junk). Generated once
 * at module load — never persisted, never logged.
 */
const { privateKey: TEST_APP_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/**
 * Stub `globalThis.fetch` for the GitHub round-trips `/auth/github/callback`
 * makes: the OAuth code exchange, the `/user` profile fetch, the
 * `/user/memberships/orgs/{login}` admin proof, and `/app/installations/<id>`
 * (the metadata pull that the callback UPSERTs from). Everything else
 * falls through to the real fetch.
 *
 * `installAccountIsAdmin` only matters for Org-type installs:
 *   - true  → state=active, role=admin (admin proof passes)
 *   - false → state=active, role=member (proof fails)
 *
 * User-type installs short-circuit before the HTTP call so the stub is
 * unused there.
 */
function stubGithub(opts: {
  githubId: number;
  login: string;
  installationIds: number[];
  installAccountLogin?: string;
  installAccountType?: "User" | "Organization";
  installAccountGithubId?: number;
  installAccountIsAdmin?: boolean;
}) {
  const original = globalThis.fetch;
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  const spy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({
          access_token: "gho_stub_access",
          expires_in: 28_800,
          refresh_token: "ghr_stub_refresh",
          refresh_token_expires_in: 15_811_200,
          scope: "",
          token_type: "bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({
          id: opts.githubId,
          login: opts.login,
          name: opts.login,
          email: `${opts.login}@example.com`,
          avatar_url: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.github.com/user/memberships/orgs/")) {
      const isAdmin = opts.installAccountIsAdmin ?? true;
      return new Response(JSON.stringify({ state: "active", role: isAdmin ? "admin" : "member" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const appInstallMatch = url.match(/^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/);
    if (appInstallMatch?.[1]) {
      const installationId = Number(appInstallMatch[1]);
      return new Response(
        JSON.stringify({
          id: installationId,
          account: {
            type: opts.installAccountType ?? "Organization",
            login: opts.installAccountLogin ?? "acme",
            id: opts.installAccountGithubId ?? 990_001,
          },
          permissions: {},
          events: [],
          suspended_at: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input, init);
  });
  globalThis.fetch = spy as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function seedGithubIdentity(
  app: FastifyInstance,
  userId: string,
  githubId: number,
  login: string,
): Promise<void> {
  await app.db.insert(authIdentities).values({
    id: uuidv7(),
    userId,
    provider: "github",
    identifier: String(githubId),
    email: null,
    verifiedAt: new Date(),
    metadata: { login },
  });
}

describe("/auth/github/callback honors targetOrganizationId in the state (codex P1-3)", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: TEST_APP_PRIVATE_KEY_PEM });

  it("binds the install to the target org, not the user's primary org, when the user is its admin", async () => {
    const app = getApp();
    const githubId = 770_001;
    const login = `targetorg-admin-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_001;

    // userA: admin of the DEFAULT org (this is their *primary* org).
    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, githubId, login);

    // orgB: a second org userA admins — and the one the install targets.
    // Backdate its membership so the default org stays the most-recent
    // (primary) one — binding to orgB then proves the targetOrg branch ran.
    const orgBId = uuidv7();
    await app.db.insert(organizations).values({ id: orgBId, name: `targetorg-${orgBId}`, displayName: "Target Org" });
    const orgBMember = await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: orgBId,
      role: "admin",
      displayName: "Target Org Admin",
      username: login,
    });
    await app.db
      .update(members)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(members.id, orgBMember.id));

    // The callback's UPSERT lands the row from the stubbed `/app/installations/<id>`
    // response (account "acme", id 990_001) — no pre-seed needed now that the
    // codex P2 fix makes the bind step depend on the upsert succeeding.

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github", {
      targetOrganizationId: orgBId,
    });
    const restore = stubGithub({ githubId, login, installationIds: [installationId] });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}&installation_id=${installationId}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      expect(res.statusCode).toBe(302);
      const params = new URLSearchParams(res.headers.location?.split("#")[1] ?? "");
      // Caller's `next` is preserved (the Settings page), not rewritten to "/".
      expect(params.get("next")).toBe("/settings/github");
      expect(params.get("joinPath")).toBe("returning");
    } finally {
      restore();
    }

    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).toBe(orgBId);
    expect(row?.hubOrganizationId).not.toBe(admin.organizationId);
  });

  it("refuses the bind (via the SPA error surface) when the user is not an admin of the target org", async () => {
    const app = getApp();
    const githubId = 770_002;
    const login = `targetorg-member-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_002;

    // userA exists but is only a *member* (not admin) of orgB.
    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, githubId, login);
    const orgBId = uuidv7();
    await app.db.insert(organizations).values({ id: orgBId, name: `targetorg-${orgBId}`, displayName: "Target Org" });
    await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: orgBId,
      role: "member",
      displayName: "Target Org Member",
      username: login,
    });

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

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github", {
      targetOrganizationId: orgBId,
    });
    const restore = stubGithub({ githubId, login, installationIds: [installationId] });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}&installation_id=${installationId}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      // Browser-facing refusal: friendly SPA error page, not raw JSON.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/auth/github/complete#");
      expect(res.headers.location).toContain("error=install-not-admin");
    } finally {
      restore();
    }

    // The install stays unbound — the refusal short-circuits before the bind.
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("refuses to bind when the caller is a non-admin member of the GitHub org install", async () => {
    // Hijack vector: a plain GitHub org member (NOT admin) could pass
    // that org's installation_id; the old `/user/installations` check
    // would accept them. The admin-proof check calls
    // `/user/memberships/orgs/{login}` and requires role=admin — a
    // non-admin member must fail.
    //
    // Sign-in still succeeds (user authenticated by their GitHub identity);
    // only `installationId` is cleared so no row gets bound.
    const app = getApp();
    const githubId = 770_004;
    const login = `targetorg-githubmember-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_004;

    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, githubId, login);

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github");
    const restore = stubGithub({
      githubId,
      login,
      installationIds: [installationId],
      installAccountType: "Organization",
      installAccountLogin: "acme",
      installAccountGithubId: 990_001,
      installAccountIsAdmin: false, // member, not admin → admin proof fails
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}&installation_id=${installationId}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      // Sign-in succeeds (302) — only the install bind is refused.
      expect(res.statusCode).toBe(302);
    } finally {
      restore();
    }

    // The installation row is NOT created (the upsert is gated behind
    // admin proof passing) and the user's First Tree team has no install bound.
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row).toBeNull();
  });

  it("binds via the kickoff session's authority when the callback GitHub identity differs", async () => {
    // The incident class behind this test: an org admin kicks off the
    // install (admin-gated, so their authority is proven at mint time),
    // but the browser's github.com session belongs to a DIFFERENT GitHub
    // identity (second account, recreated account, someone else's First Tree
    // session in the same browser). GitHub completes the install either
    // way; the bind must rest on the kickoff session signed into the
    // state, not on whoever the OAuth code resolves to.
    const app = getApp();
    const kickoffGithubId = 770_005;
    const strangerGithubId = 770_006;
    const login = `targetorg-kickoff-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_005;

    // Kickoff admin: admin of their own org, linked to kickoffGithubId.
    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, kickoffGithubId, login);

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/onboarding/connected", {
      targetOrganizationId: admin.organizationId,
      kickoffUserId: admin.userId,
    });
    // The OAuth exchange resolves a stranger identity (never seen before).
    const restore = stubGithub({
      githubId: strangerGithubId,
      login: `${login}-stranger`,
      installationIds: [installationId],
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}&installation_id=${installationId}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      // Install completes: redirect straight to `next` — and WITHOUT a
      // token fragment, so the stranger identity must not replace the
      // kickoff admin's browser session.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/onboarding/connected");
      expect(res.headers.location).not.toContain("access=");
    } finally {
      restore();
    }

    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).toBe(admin.organizationId);
  });

  it("redirects to a friendly error page when the kickoff admin's membership was revoked mid-flight", async () => {
    const app = getApp();
    const githubId = 770_007;
    const login = `targetorg-revoked-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_006;

    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, githubId, login);

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github", {
      targetOrganizationId: admin.organizationId,
      kickoffUserId: admin.userId,
    });
    // Membership revoked between mint and callback: flip role to member.
    await app.db.update(members).set({ role: "member" }).where(eq(members.userId, admin.userId));

    const restore = stubGithub({ githubId, login, installationIds: [installationId] });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}&installation_id=${installationId}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      // Refusal is correct — but it must land on the SPA's friendly error
      // surface, not a raw JSON body at the API URL.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/auth/github/complete#");
      expect(res.headers.location).toContain("error=install-not-admin");
      expect(res.headers.location).not.toContain("access=");
    } finally {
      restore();
    }

    // The install stays unbound — the refusal short-circuits the bind.
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("ignores a targetOrganizationId naming an org the user isn't a member of", async () => {
    const app = getApp();
    const githubId = 770_003;
    const login = `targetorg-stranger-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_003;

    // Brand-new GitHub user; the callback mints them with no membership in
    // the default org → `findActiveMembership` returns null → refusal via
    // the SPA error surface (no kickoffUserId in this legacy-shape state,
    // so the OAuth identity is the bind authority).
    const defaultOrgId = await resolveDefaultOrgId(app.db);
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
    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github", {
      targetOrganizationId: defaultOrgId,
    });
    const restore = stubGithub({ githubId, login, installationIds: [installationId] });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}&installation_id=${installationId}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/auth/github/complete#");
      expect(res.headers.location).toContain("error=install-not-admin");
    } finally {
      restore();
    }
  });
});
