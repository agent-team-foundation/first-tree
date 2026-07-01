import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { githubAppInstallIntents } from "../db/schema/github-app-install-intents.js";
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

  it("resolves + pins the target org (not the user's primary org) when the kickoff admin matches", async () => {
    const app = getApp();
    const githubId = 770_001;
    const login = `targetorg-admin-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_001;

    // userA: admin of the DEFAULT org (this is their *primary* org).
    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, githubId, login);

    // orgB: a second org userA admins — and the one the install targets.
    // Backdate its membership so the default org stays the most-recent
    // (primary) one — resolving to orgB then proves the targetOrg branch ran.
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

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github", {
      targetOrganizationId: orgBId,
      kickoffUserId: admin.userId,
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
      // The install target is a deliberate destination: even though the join
      // path reads as "returning", the org must be pinned so the SPA activates
      // the target org instead of restoring the user's last-used one.
      expect(params.get("org")).toBe(orgBId);
      expect(params.get("orgPinned")).toBe("1");
    } finally {
      restore();
    }

    // The callback no longer binds (nor upserts) the installation — binding is
    // driven by the trusted `installation.created` webhook. So no row exists
    // from the callback; only the org resolution/pinning above is the
    // callback's job.
    expect(await findInstallationByGithubId(app.db, installationId)).toBeNull();
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

  it("refuses (error, no bind) when the install is completed under a different GitHub identity than the kickoff admin", async () => {
    // A kickoff admin starts the install (admin-gated at mint), but the
    // browser's github.com session resolves to a DIFFERENT GitHub identity.
    // In the webhook-sourced binding model this install cannot bind (the
    // intent is keyed by the kickoff admin's GitHub id; the webhook `sender`
    // won't match), and we must not sign the browser in as the foreign
    // identity. The callback surfaces `install-not-verified` and binds
    // nothing.
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
      // Error surface, no session token issued for the stranger identity.
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/auth/github/complete#");
      expect(res.headers.location).toContain("error=install-not-verified");
      expect(res.headers.location).not.toContain("access=");
    } finally {
      restore();
    }

    // Nothing bound (and nothing upserted) by the callback.
    expect(await findInstallationByGithubId(app.db, installationId)).toBeNull();
  });

  it("does NOT bind (and records no pending bind) when a matching installation row exists but the callback identity mismatches", async () => {
    // Regression (yuezengwu): the signed webhook already created the
    // installation row with the kickoff admin as installer, but the callback
    // is completed under a DIFFERENT GitHub identity carrying that
    // installation_id in the URL. The mismatch guard must run BEFORE any
    // pending-bind side effect — expect install-not-verified, no bind, and no
    // lingering pending bind.
    const app = getApp();
    const kickoffGithubId = 770_020;
    const strangerGithubId = 770_021;
    const login = `targetorg-preinstalled-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_020;

    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, kickoffGithubId, login);

    // The signed webhook already recorded this installation with the kickoff
    // admin as its installer.
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "acme",
        accountGithubId: 990_020,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
      installerGithubId: kickoffGithubId,
    });

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/settings/github", {
      targetOrganizationId: admin.organizationId,
      kickoffUserId: admin.userId,
    });
    // OAuth resolves to a stranger; the URL carries the pre-installed id.
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
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("error=install-not-verified");
      expect(res.headers.location).not.toContain("access=");
    } finally {
      restore();
    }

    // No bind, despite the matching installer row...
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).toBeNull();
    // ...and no pending bind was recorded (the mismatch guard ran first).
    const pending = await app.db
      .select()
      .from(githubAppInstallIntents)
      .where(eq(githubAppInstallIntents.installationId, installationId))
      .limit(1);
    expect(pending).toHaveLength(0);
  });

  it("surfaces an error (not success) when the identities mismatch, regardless of installation_id", async () => {
    // Review finding (yuezengwu + codex): the mismatch branch must NOT
    // bounce to the success `next` — in onboarding that page auto-closes as
    // "connected" while nothing was bound. Holds whether or not an
    // installation_id rides the callback (binding is webhook-driven).
    const app = getApp();
    const kickoffGithubId = 770_008;
    const strangerGithubId = 770_009;
    const login = `targetorg-noinstall-${uuidv7().slice(0, 6)}`;

    const admin = await createTestAdmin(app, { username: `${login}-u` });
    await seedGithubIdentity(app, admin.userId, kickoffGithubId, login);

    const { token, nonce } = await signOAuthState(TEST_JWT_SECRET, "/onboarding/connected", {
      targetOrganizationId: admin.organizationId,
      kickoffUserId: admin.userId,
    });
    const restore = stubGithub({ githubId: strangerGithubId, login: `${login}-stranger`, installationIds: [] });
    try {
      // No installation_id on the callback at all.
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=devcode&state=${token}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/auth/github/complete#");
      expect(res.headers.location).toContain("error=install-not-verified");
      expect(res.headers.location).not.toContain("access=");
      // Review finding round 2: the error page renders `next` as its "Back
      // to First Tree" link — it must NOT point at the auto-close
      // "Connected" sentinel, or the error page offers a false-success
      // escape hatch. The onboarding popup path normalizes to /onboarding.
      const fragment = new URLSearchParams(res.headers.location?.split("#")[1] ?? "");
      expect(fragment.get("next")).toBe("/onboarding");
    } finally {
      restore();
    }
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

    // The callback binds/upserts nothing — the authority refusal short-circuits,
    // and binding is webhook-driven regardless. No row is created here.
    expect(await findInstallationByGithubId(app.db, installationId)).toBeNull();
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
