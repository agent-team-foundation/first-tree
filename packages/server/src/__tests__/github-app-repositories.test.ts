import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

// A real RSA key so `createAppJwt` (which mints the installation token) can
// actually sign — the helpers' default `privateKeyPem` is deliberate junk.
const { privateKey: TEST_APP_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/**
 * `GET /orgs/:orgId/github-app-installation/repositories` — admin-only list
 * of the repos the team's GitHub App installation can access. Powers the
 * onboarding admin connect-code project picker. Admin-gated (not
 * member-readable like `/exists`) because the response is the full
 * installation candidate catalog — private repo names / clone URLs the
 * caller may not be a GitHub collaborator on.
 *
 * The product is team-by-default, so the picker offers the team's *org*
 * code (the installation's grant) rather than the admin's personal
 * `/user/repos` — personal repos drop out and we only ever surface repos
 * the agent can actually reach.
 */
describe("GET /orgs/:orgId/github-app-installation/repositories", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: TEST_APP_PRIVATE_KEY_PEM });

  async function seedInstallation(
    app: ReturnType<typeof getApp>,
    orgId: string,
    installationId: number,
    opts: { suspendedAt?: string | null } = {},
  ) {
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: `org-${installationId}`,
        accountGithubId: installationId * 10,
        permissions: { contents: "read" },
        events: [],
        suspendedAt: opts.suspendedAt ?? null,
      },
    });
    await bindInstallationToOrg(app.db, installationId, orgId);
  }

  /** Stub `globalThis.fetch` to fail the `/installation/repositories` call. */
  function stubGithubReposError(status: number): () => void {
    const original = globalThis.fetch;
    const spy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
        return new Response(JSON.stringify({ token: "ghs_stub", expires_at: "2099-01-01T00:00:00Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.github.com/installation/repositories")) {
        return new Response("upstream boom", { status });
      }
      return original(input, init);
    });
    globalThis.fetch = spy as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  function stubGithubTokenError(status: number): () => void {
    const original = globalThis.fetch;
    const spy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
        return new Response("token mint failed", { status });
      }
      return original(input, init);
    });
    globalThis.fetch = spy as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  /**
   * Stub `globalThis.fetch` for the two GitHub round-trips this route makes:
   * mint an installation token, then list `/installation/repositories`.
   * Anything else falls through to the real fetch.
   */
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  function stubGithub(repositories: Array<{ full_name: string; pushed_at: string | null }>): () => void {
    const original = globalThis.fetch;
    const spy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
        return new Response(
          JSON.stringify({ token: "ghs_stub", expires_at: "2099-01-01T00:00:00Z", repository_selection: "selected" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.github.com/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: repositories.length,
            repositories: repositories.map((r) => ({
              full_name: r.full_name,
              clone_url: `https://github.com/${r.full_name}.git`,
              html_url: `https://github.com/${r.full_name}`,
              private: true,
              default_branch: "main",
              pushed_at: r.pushed_at,
            })),
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

  let restoreFetch: (() => void) | null = null;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it("returns the installation's repos (org-scoped), sorted most-recently-pushed first", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 910_001);
    restoreFetch = stubGithub([
      { full_name: "acme/old", pushed_at: "2024-01-01T00:00:00Z" },
      { full_name: "acme/new", pushed_at: "2025-01-01T00:00:00Z" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ repos: Array<{ fullName: string }> }>();
    expect(body.repos.map((r) => r.fullName)).toEqual(["acme/new", "acme/old"]);
  });

  it("503 suspended when the installation is suspended", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 910_003, { suspendedAt: "2025-01-01T00:00:00Z" });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe("suspended");
  });

  it("502 upstream when GitHub rejects the repo-list call", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 910_004);
    restoreFetch = stubGithubReposError(500);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ code: string }>().code).toBe("upstream");
  });

  it("502 upstream when GitHub rejects the installation token mint", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 910_005);
    restoreFetch = stubGithubTokenError(500);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ code: string }>().code).toBe("upstream");
  });

  it("503 not_configured when the server has no GitHub App config", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });
    await seedInstallation(app, admin.organizationId, 910_006);
    const originalOauth = app.config.oauth;
    app.config.oauth = undefined;
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe("not_configured");
    } finally {
      app.config.oauth = originalOauth;
    }
  });

  it("503 no_installation when the team has no installation bound", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe("no_installation");
  });

  it("requires admin — a non-admin member is forbidden (the response is the full installation catalog)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `r-admin-${crypto.randomUUID().slice(0, 8)}` });

    // Demote to a plain member, then re-login so the JWT carries role:member.
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

    // Even with an installation bound, a non-admin must be refused before any
    // GitHub call — the payload exposes the full installation candidate
    // catalog (private repo names / clone URLs), which is admin-only.
    await seedInstallation(app, admin.organizationId, 910_002);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/repositories`,
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
