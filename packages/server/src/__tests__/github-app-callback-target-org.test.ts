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
 * `/user/installations` access check, and `/app/installations/<id>` (the
 * metadata pull that the callback UPSERTs from). Everything else falls
 * through to the real fetch.
 *
 * Returning `/app/installations/<id>` from the stub lets the codex P2 fix
 * — clear `installationId` on upsert failure — exercise its happy path:
 * the bind step only runs when the metadata fetch + upsert succeed.
 */
function stubGithub(opts: {
  githubId: number;
  login: string;
  installationIds: number[];
  installAccountLogin?: string;
  installAccountType?: "User" | "Organization";
  installAccountGithubId?: number;
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
    if (url.startsWith("https://api.github.com/user/installations")) {
      return new Response(
        JSON.stringify({
          total_count: opts.installationIds.length,
          installations: opts.installationIds.map((id) => ({ id })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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

  it("403s when the user is not an admin of the target org", async () => {
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
      expect(res.statusCode).toBe(403);
    } finally {
      restore();
    }

    // The install stays unbound — the 403 short-circuits before the bind.
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("ignores a targetOrganizationId naming an org the user isn't a member of", async () => {
    const app = getApp();
    const githubId = 770_003;
    const login = `targetorg-stranger-${uuidv7().slice(0, 6)}`;
    const installationId = 8_822_003;

    // Brand-new GitHub user; the callback mints them with no membership in
    // the default org → `findActiveMembership` returns null → 403.
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
      expect(res.statusCode).toBe(403);
    } finally {
      restore();
    }
  });
});
