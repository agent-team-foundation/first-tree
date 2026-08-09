import { githubExternalProfile } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { protectOAuthStateNonce } from "../api/auth/oauth-cookie.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { linkExternalIdentity } from "../services/auth-identity.js";
import { signOAuthState } from "../services/oauth-state.js";

// Hoist mock for `exchangeCodeForAppUserProfile` so the GitHub route
// resolves to this instead of the real network call. This is the sanctioned
// ESM mocking strategy (module factory), not namespace assignment on an
// imported binding.
const { mockExchangeCode } = vi.hoisted(() => ({
  mockExchangeCode: vi.fn(),
}));

vi.mock("../services/github-app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/github-app.js")>();
  return { ...actual, exchangeCodeForAppUserProfile: mockExchangeCode };
});

import type { FastifyInstance } from "fastify";

const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ISSUER = "https://idp.test";

type CreateTestApp = typeof import("./helpers.js")["createTestApp"];

/** Parse the `#fragment` params from an `/auth/complete#...` redirect Location. */
function parseFragment(location: string): URLSearchParams {
  const hash = location.split("#")[1] ?? "";
  return new URLSearchParams(hash);
}

/**
 * Build a GitHub install callback request with a signed state JWT and matching
 * encrypted nonce cookie. The state includes the verified kickoff authority
 * tuple (targetOrganizationId, kickoffUserId, installPhase, provider).
 */
async function buildInstallCallback(
  app: FastifyInstance,
  opts: { kickoffUserId: string; targetOrganizationId: string; next?: string },
): Promise<{ url: string; cookie: string }> {
  const { token, nonce } = await signOAuthState(
    app.config.secrets.jwtSecret,
    opts.next ?? "/settings/integrations/github",
    {
      provider: "github",
      intent: "install",
      installPhase: "installation",
      targetOrganizationId: opts.targetOrganizationId,
      kickoffUserId: opts.kickoffUserId,
    },
  );
  const cookie = `oauth_state_nonce=${encodeURIComponent(protectOAuthStateNonce(nonce, TEST_ENCRYPTION_KEY))}`;
  return {
    url: `/api/v1/auth/github/callback?code=test-code&state=${encodeURIComponent(token)}`,
    cookie,
  };
}

describe("GitHub install — oidc-required mode session preservation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Reset the shared-worker module registry so the dynamic import below
    // rebuilds the app graph against the hoisted `vi.mock("../services/github-app.js")`.
    vi.resetModules();
    const { createTestApp } = (await import("./helpers.js")) as { createTestApp: CreateTestApp };
    app = await createTestApp({
      authMode: "oidc-required",
      oidc: { issuer: ISSUER, clientId: "test-oidc-client-id", clientSecret: "test-oidc-client-secret" },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    // Default: the code exchange returns a profile matching the linked identity.
    mockExchangeCode.mockResolvedValue({
      profile: {
        githubId: "12345",
        login: "kickoff-user",
        email: "kickoff@example.com",
        displayName: "Kickoff User",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      },
      accessToken: "ghu_test",
      accessTokenExpiresAt: new Date(Date.now() + 28800000).toISOString(),
      refreshToken: "ghr_test",
      refreshTokenExpiresAt: new Date(Date.now() + 15552000000).toISOString(),
      scope: "read:user user:email",
      installationId: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("anchors to the existing kickoff user (no new GitHub-only account) and returns metadata-only (no session tokens)", async () => {
    // Seed a kickoff admin with a linked GitHub identity.
    const { createTestAdmin } = await import("./helpers.js");
    const admin = await createTestAdmin(app, { username: "kickoff-admin" });
    const external = githubExternalProfile({
      id: "12345",
      login: "kickoff-user",
      name: "Kickoff User",
      email: "kickoff@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      metadata: {},
    });
    await linkExternalIdentity(app.db, admin.userId, external);

    // Verify the GitHub identity was seeded.
    const [identity] = await app.db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, admin.userId), eq(authIdentities.provider, "github")));
    expect(identity?.identifier).toBe("12345");

    const { url, cookie } = await buildInstallCallback(app, {
      kickoffUserId: admin.userId,
      targetOrganizationId: admin.organizationId,
    });
    const res = await app.inject({ method: "GET", url, headers: { cookie } });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith("/auth/complete#")).toBe(true);
    const fragment = parseFragment(location);
    // Install metadata-only redirect does not set `provider` in the fragment.
    expect(fragment.get("callbackIntent")).toBe("install");
    expect(fragment.get("callbackIntent")).toBe("install");
    // Metadata-only: no session tokens minted in oidc-required mode.
    expect(fragment.get("access")).toBeNull();
    expect(fragment.get("refresh")).toBeNull();
    expect(fragment.get("next")).toBe("/settings/integrations/github");
    // The org must be pinned so the SPA activates it.
    expect(fragment.get("org")).toBe(admin.organizationId);
    expect(fragment.get("orgPinned")).toBe("1");

    // Verify no new user was created: the callback anchored to the existing kickoff user.
    const allIdentities = await app.db.select().from(authIdentities).where(eq(authIdentities.provider, "github"));
    expect(allIdentities).toHaveLength(1);
    expect(allIdentities[0]?.userId).toBe(admin.userId);
  });

  it("fails closed when the GitHub.com account does not match the kickoff user's linked identity", async () => {
    const { createTestAdmin } = await import("./helpers.js");
    const admin = await createTestAdmin(app, { username: "kickoff-admin-mismatch" });
    const external = githubExternalProfile({
      id: "99999",
      login: "kickoff-different",
      name: "Kickoff Different",
      email: "kickoff@example.com",
      avatarUrl: null,
      metadata: {},
    });
    await linkExternalIdentity(app.db, admin.userId, external);

    // The mock exchange returns githubId "12345", but the linked identity is "99999".
    const { url, cookie } = await buildInstallCallback(app, {
      kickoffUserId: admin.userId,
      targetOrganizationId: admin.organizationId,
    });
    const res = await app.inject({ method: "GET", url, headers: { cookie } });

    expect(res.statusCode).toBe(302);
    const fragment = parseFragment(res.headers.location as string);
    expect(fragment.get("error")).toBe("install-not-verified");
    expect(fragment.get("callbackIntent")).toBe("install");
    expect(fragment.get("next")).toBe("/settings/integrations/github");
  });
});

describe("GitHub install — standard mode mints session", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.resetModules();
    const { createTestApp } = (await import("./helpers.js")) as { createTestApp: CreateTestApp };
    app = await createTestApp({ authMode: "standard" });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    mockExchangeCode.mockResolvedValue({
      profile: {
        githubId: "67890",
        login: "standard-user",
        email: "standard@example.com",
        displayName: "Standard User",
        avatarUrl: null,
      },
      accessToken: "ghu_standard",
      accessTokenExpiresAt: new Date(Date.now() + 28800000).toISOString(),
      refreshToken: "ghr_standard",
      refreshTokenExpiresAt: new Date(Date.now() + 15552000000).toISOString(),
      scope: "read:user user:email",
      installationId: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("mints a session (access + refresh tokens) for the kickoff user in standard mode", async () => {
    const { createTestAdmin } = await import("./helpers.js");
    const admin = await createTestAdmin(app, { username: "standard-kickoff" });
    const external = githubExternalProfile({
      id: "67890",
      login: "standard-user",
      name: "Standard User",
      email: "standard@example.com",
      avatarUrl: null,
      metadata: {},
    });
    await linkExternalIdentity(app.db, admin.userId, external);

    const { url, cookie } = await buildInstallCallback(app, {
      kickoffUserId: admin.userId,
      targetOrganizationId: admin.organizationId,
    });
    const res = await app.inject({ method: "GET", url, headers: { cookie } });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    const fragment = parseFragment(location);
    expect(fragment.get("callbackIntent")).toBe("install");
    // In standard mode, install DOES mint a session.
    expect(fragment.get("access")).toBeTruthy();
    expect(fragment.get("refresh")).toBeTruthy();
    expect(fragment.get("org")).toBe(admin.organizationId);
    expect(fragment.get("orgPinned")).toBe("1");
  });
});

// File-level cleanup: unmock and reset modules after all tests finish.
afterAll(() => {
  vi.doUnmock("../services/github-app.js");
  vi.resetModules();
});
