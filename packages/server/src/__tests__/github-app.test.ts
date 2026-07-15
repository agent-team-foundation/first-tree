import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, importPKCS8, jwtVerify } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildAppAuthorizeUrl,
  createAppJwt,
  createOrganizationRepo,
  createPullRequestReview,
  createRepoFileWithToken,
  exchangeCodeForAppUserProfile,
  fetchInstallation,
  GithubAppApiError,
  getPullRequestForReview,
  getRepoFileWithToken,
  getRepository,
  listInstallationRepos,
  listPullRequestReviewsForRun,
  mintInstallationToken,
  refreshAppUserToken,
  verifyUserCanAdministerInstallation,
} from "../services/github-app.js";

/**
 * Service-layer unit tests for `services/github-app.ts`. Pure module tests;
 * no Fastify test app, no DB. A throwaway RSA-2048 keypair is generated
 * per `describe` block so we never check a real (or even "test-real") key
 * into the repo — there's nothing for a curious reader to mistake for a
 * production secret.
 *
 * The `mintInstallationToken` / `refreshAppUserToken` tests inject a
 * `fetcher` so the GitHub round-trip is replaced by an in-process stub.
 * That mirrors the pattern used by `listUserRepos` in `github-oauth.ts`.
 */
describe("services/github-app", () => {
  let appId: string;
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeAll(() => {
    appId = "123456";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;
    publicKeyPem = publicKey;
  });

  describe("createAppJwt", () => {
    it("returns a JWT signed with RS256 carrying iss=appId", async () => {
      const jwt = await createAppJwt({ appId, privateKeyPem });
      const header = decodeProtectedHeader(jwt);
      expect(header.alg).toBe("RS256");
      const payload = decodeJwt(jwt);
      expect(payload.iss).toBe(appId);
      expect(typeof payload.iat).toBe("number");
      expect(typeof payload.exp).toBe("number");
    });

    it("backdates iat by ~60s to absorb clock skew", async () => {
      const before = Math.floor(Date.now() / 1000);
      const jwt = await createAppJwt({ appId, privateKeyPem });
      const after = Math.floor(Date.now() / 1000);
      const payload = decodeJwt(jwt);
      // iat is "now - 60s" rounded down to a whole second; allow ±2s slop
      // for the work between the `before` capture and the `setIssuedAt`
      // call inside `createAppJwt`.
      const iat = payload.iat;
      if (typeof iat !== "number") throw new Error("expected numeric iat");
      expect(iat).toBeGreaterThanOrEqual(before - 62);
      expect(iat).toBeLessThanOrEqual(after - 58);
    });

    it("expires within the 10-minute GitHub upper bound", async () => {
      const jwt = await createAppJwt({ appId, privateKeyPem });
      const payload = decodeJwt(jwt);
      const iat = payload.iat;
      const exp = payload.exp;
      if (typeof iat !== "number" || typeof exp !== "number") throw new Error("expected numeric iat/exp");
      // 9-minute expiry plus 60s iat skew = ≤600s span; GitHub rejects >600s.
      expect(exp - iat).toBeLessThanOrEqual(600);
    });

    it("verifies against the matching public key", async () => {
      const jwt = await createAppJwt({ appId, privateKeyPem });
      // Build a SPKI key for verification — this is what GitHub's edge
      // does on receipt. If the signature is malformed jwtVerify throws.
      const pubKey = await importPKCS8(privateKeyPem, "RS256");
      // Use the private key for verify too — RS256 verifies with a public
      // key derived from the same keypair. We re-derive via `crypto` to
      // confirm the signature actually validates end-to-end.
      const { createPublicKey } = await import("node:crypto");
      const pub = createPublicKey(publicKeyPem);
      const { payload } = await jwtVerify(jwt, pub);
      expect(payload.iss).toBe(appId);
      // No-op reference to pubKey to silence "declared but never used" —
      // confirms importPKCS8 accepted the PEM, which is part of the test.
      expect(pubKey).toBeDefined();
    });

    it("rejects an invalid PEM", async () => {
      await expect(createAppJwt({ appId, privateKeyPem: "not a pem" })).rejects.toThrow();
    });
  });

  describe("mintInstallationToken", () => {
    it("POSTs to /app/installations/:id/access_tokens with bearer header and parses success", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fakeFetch: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            token: "ghs_installation_token",
            expires_at: "2026-05-11T18:00:00Z",
            permissions: { contents: "write", issues: "read" },
            repository_selection: "selected",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      };
      const result = await mintInstallationToken("app-jwt-stub", 7777, { fetcher: fakeFetch });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.github.com/app/installations/7777/access_tokens");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer app-jwt-stub");
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(calls[0]?.init?.method).toBe("POST");
      expect(result).toEqual({
        token: "ghs_installation_token",
        expiresAt: "2026-05-11T18:00:00Z",
        permissions: { contents: "write", issues: "read" },
        repositorySelection: "selected",
      });
    });

    it("defaults repositorySelection to 'all' when GitHub omits the field", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ token: "t", expires_at: "2026-01-01T00:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      const result = await mintInstallationToken("jwt", 1, { fetcher: fakeFetch });
      expect(result.repositorySelection).toBe("all");
      expect(result.permissions).toEqual({});
    });

    it("throws GithubAppApiError with status on non-2xx", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      await expect(mintInstallationToken("jwt", 1, { fetcher: fakeFetch })).rejects.toMatchObject({
        name: "GithubAppApiError",
        status: 401,
      });
    });

    it("scopes a token request to one repository and the requested permissions", async () => {
      const fakeFetch = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              token: "scoped-token",
              expires_at: "2026-05-11T18:00:00Z",
              permissions: { metadata: "read", pull_requests: "write" },
              repository_selection: "selected",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      );
      await mintInstallationToken("jwt", 7, {
        fetcher: fakeFetch,
        repositories: ["context-tree"],
        permissions: { metadata: "read", pull_requests: "write" },
      });
      expect(JSON.parse(String(fakeFetch.mock.calls[0]?.[1]?.body))).toEqual({
        repositories: ["context-tree"],
        permissions: { metadata: "read", pull_requests: "write" },
      });
    });
  });

  describe("Context Reviewer pull request API", () => {
    it("reads current PR state and creates a commit-bound App review", async () => {
      const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
        if (!init?.method) {
          return new Response(
            JSON.stringify({
              number: 42,
              state: "open",
              draft: false,
              merged: false,
              head: { sha: "a".repeat(40) },
              html_url: "https://github.com/owner/repo/pull/42",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 9,
            html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-9",
            user: { login: "first-tree[bot]" },
            commit_id: "a".repeat(40),
            body: "Approved",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      await expect(
        getPullRequestForReview("token", "owner", "repo", 42, { fetcher: fakeFetch }),
      ).resolves.toMatchObject({
        state: "open",
        headSha: "a".repeat(40),
      });
      await expect(
        createPullRequestReview(
          "token",
          {
            owner: "owner",
            repo: "repo",
            prNumber: 42,
            commitId: "a".repeat(40),
            event: "APPROVE",
            body: "Approved",
          },
          { fetcher: fakeFetch },
        ),
      ).resolves.toMatchObject({ id: 9, actor: "first-tree[bot]" });
      expect(JSON.parse(String(fakeFetch.mock.calls[1]?.[1]?.body))).toEqual({
        commit_id: "a".repeat(40),
        event: "APPROVE",
        body: "Approved",
      });
    });

    it("paginates review reconciliation until it finds the hidden run marker", async () => {
      const marker = "<!-- first-tree-context-review-run:run-42 -->";
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        html_url: `https://github.com/owner/repo/pull/42#pullrequestreview-${index + 1}`,
        user: { login: "someone-else" },
        commit_id: "a".repeat(40),
        body: "Unrelated review",
      }));
      const fakeFetch = vi.fn<typeof fetch>(async (url) => {
        const target = String(url);
        const reviews = target.endsWith("&page=2")
          ? [
              {
                id: 101,
                html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-101",
                user: { login: "first-tree[bot]" },
                commit_id: "a".repeat(40),
                body: marker,
              },
            ]
          : firstPage;
        return new Response(JSON.stringify(reviews), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      await expect(
        listPullRequestReviewsForRun(
          "token",
          { owner: "owner", repo: "repo", prNumber: 42, marker, appSlug: "first-tree" },
          { fetcher: fakeFetch },
        ),
      ).resolves.toMatchObject([{ id: 101, actor: "first-tree[bot]" }]);
      expect(fakeFetch.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.github.com/repos/owner/repo/pulls/42/reviews?per_page=100",
        "https://api.github.com/repos/owner/repo/pulls/42/reviews?per_page=100&page=2",
      ]);
    });
  });

  describe("fetchInstallation", () => {
    it("GETs /app/installations/:id with bearer header and parses the account block", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fakeFetch: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            id: 5555,
            account: { id: 999, login: "acme", type: "Organization" },
            permissions: { contents: "write", issues: "read" },
            events: ["push", "issues"],
            suspended_at: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const result = await fetchInstallation("jwt-stub", 5555, { fetcher: fakeFetch });
      expect(calls[0]?.url).toBe("https://api.github.com/app/installations/5555");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer jwt-stub");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(result).toEqual({
        id: 5555,
        accountType: "Organization",
        accountLogin: "acme",
        accountGithubId: 999,
        permissions: { contents: "write", issues: "read" },
        events: ["push", "issues"],
        suspendedAt: null,
      });
    });

    it("normalizes a suspended installation to a non-null suspendedAt", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            id: 1,
            account: { id: 2, login: "u", type: "User" },
            suspended_at: "2026-05-11T10:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const result = await fetchInstallation("jwt", 1, { fetcher: fakeFetch });
      expect(result.suspendedAt).toBe("2026-05-11T10:00:00Z");
      expect(result.accountType).toBe("User");
    });

    it("throws GithubAppApiError on 404 (installation deleted upstream)", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      await expect(fetchInstallation("jwt", 1, { fetcher: fakeFetch })).rejects.toMatchObject({
        name: "GithubAppApiError",
        status: 404,
      });
    });
  });

  describe("verifyUserCanAdministerInstallation", () => {
    it("User-type: returns true when the caller's GitHub ID matches the install account", async () => {
      // No HTTP call needed for User-type — the comparison is purely ID-based.
      const fakeFetch: typeof fetch = async () => {
        throw new Error("fetch must not be called for User-type installs");
      };
      const ok = await verifyUserCanAdministerInstallation(
        "ghu_token",
        770_001,
        { accountType: "User", accountLogin: "alice", accountGithubId: 770_001 },
        { fetcher: fakeFetch },
      );
      expect(ok).toBe(true);
    });

    it("User-type: returns false when the IDs don't match (hijack attempt)", async () => {
      const ok = await verifyUserCanAdministerInstallation(
        "ghu_token",
        12_345,
        { accountType: "User", accountLogin: "alice", accountGithubId: 770_001 },
        { fetcher: async () => new Response(null, { status: 200 }) },
      );
      expect(ok).toBe(false);
    });

    it("Org-type: returns true on state=active + role=admin", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fakeFetch: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ state: "active", role: "admin" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const ok = await verifyUserCanAdministerInstallation(
        "ghu_token",
        0,
        { accountType: "Organization", accountLogin: "acme", accountGithubId: 880_001 },
        { fetcher: fakeFetch },
      );
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.github.com/user/memberships/orgs/acme");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer ghu_token");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    });

    it("Org-type: returns false when role=member (the hijack vector)", async () => {
      // Plain org member triggered the original bug — `/user/installations`
      // returned the install, but the user isn't an admin. The new check
      // catches it.
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ state: "active", role: "member" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const ok = await verifyUserCanAdministerInstallation(
        "ghu_token",
        0,
        { accountType: "Organization", accountLogin: "acme", accountGithubId: 880_001 },
        { fetcher: fakeFetch },
      );
      expect(ok).toBe(false);
    });

    it("Org-type: returns false when state=pending (invite not accepted yet)", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ state: "pending", role: "admin" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const ok = await verifyUserCanAdministerInstallation(
        "ghu_token",
        0,
        { accountType: "Organization", accountLogin: "acme", accountGithubId: 880_001 },
        { fetcher: fakeFetch },
      );
      expect(ok).toBe(false);
    });

    it("Org-type: returns false on 404 (non-member)", async () => {
      // GitHub returns 404 (not 200 with role=null) when the user isn't a
      // member of the org. Treat as clean negative answer, not an error.
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      const ok = await verifyUserCanAdministerInstallation(
        "ghu_token",
        0,
        { accountType: "Organization", accountLogin: "stranger", accountGithubId: 880_002 },
        { fetcher: fakeFetch },
      );
      expect(ok).toBe(false);
    });

    it("Org-type: throws GithubAppApiError on 401 (stale or revoked user token)", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      await expect(
        verifyUserCanAdministerInstallation(
          "stale",
          0,
          { accountType: "Organization", accountLogin: "acme", accountGithubId: 880_001 },
          { fetcher: fakeFetch },
        ),
      ).rejects.toMatchObject({ name: "GithubAppApiError", status: 401 });
    });
  });

  describe("refreshAppUserToken", () => {
    it("trades a refresh token for a fresh access + refresh pair", async () => {
      const fixedNow = new Date("2026-05-11T10:00:00.000Z");
      const calls: Array<{ url: string; body: string }> = [];
      const fakeFetch: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(
          JSON.stringify({
            access_token: "ghu_new_access",
            expires_in: 28800, // 8h
            refresh_token: "ghr_new_refresh",
            refresh_token_expires_in: 15897600, // ~6mo
            scope: "repo,user:email",
            token_type: "bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const result = await refreshAppUserToken("client-id", "client-secret", "old-refresh", {
        fetcher: fakeFetch,
        now: () => fixedNow,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
      const body = JSON.parse(calls[0]?.body ?? "{}");
      expect(body).toEqual({
        client_id: "client-id",
        client_secret: "client-secret",
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      });
      expect(result).toEqual({
        accessToken: "ghu_new_access",
        // fixedNow + 28800s = 18:00:00Z
        accessTokenExpiresAt: "2026-05-11T18:00:00.000Z",
        refreshToken: "ghr_new_refresh",
        // fixedNow + 15897600s = +184 days = 2026-11-11
        refreshTokenExpiresAt: "2026-11-11T10:00:00.000Z",
        scope: "repo,user:email",
      });
    });

    it("maps GitHub's 200-with-`error` body to a 401 GithubAppApiError so callers re-login", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            error: "bad_refresh_token",
            error_description: "The refresh token passed is incorrect or expired.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      await expect(refreshAppUserToken("cid", "csec", "stale", { fetcher: fakeFetch })).rejects.toMatchObject({
        name: "GithubAppApiError",
        status: 401,
      });
    });

    it("rejects loudly when GitHub omits expires_in (App misconfigured)", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            // expires_in / refresh_token_expires_in deliberately omitted
            scope: "repo",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const err = (await refreshAppUserToken("cid", "csec", "x", { fetcher: fakeFetch }).catch(
        (e: unknown) => e,
      )) as GithubAppApiError;
      expect(err).toBeInstanceOf(GithubAppApiError);
      expect(err.status).toBe(500);
      expect(err.message).toContain("expires_in");
    });

    it("surfaces transport errors as GithubAppApiError with upstream status", async () => {
      const fakeFetch: typeof fetch = async () => new Response("", { status: 502 });
      await expect(refreshAppUserToken("cid", "csec", "x", { fetcher: fakeFetch })).rejects.toMatchObject({
        name: "GithubAppApiError",
        status: 502,
      });
    });
  });

  describe("buildAppAuthorizeUrl", () => {
    it("builds an authorize URL with client_id / redirect_uri / state / allow_signup", () => {
      const url = buildAppAuthorizeUrl({
        clientId: "Iv23liABCDEF",
        redirectUri: "https://first-tree.example.com/api/v1/auth/github/callback",
        state: "signed.state.jwt",
      });
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("Iv23liABCDEF");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://first-tree.example.com/api/v1/auth/github/callback",
      );
      expect(parsed.searchParams.get("state")).toBe("signed.state.jwt");
      expect(parsed.searchParams.get("allow_signup")).toBe("true");
      // Permissions are declared on the App's GitHub-side settings page,
      // NOT in the URL (design doc D0b). Including them here would let
      // an attacker craft a downgrade prompt.
      expect(parsed.searchParams.get("scope")).toBeNull();
      expect(parsed.searchParams.get("permissions")).toBeNull();
    });
  });

  describe("exchangeCodeForAppUserProfile", () => {
    const fixedNow = new Date("2026-05-11T10:00:00.000Z");

    it("trades the code for profile + token pair + expiries", async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fakeFetch: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url) === "https://github.com/login/oauth/access_token") {
          return new Response(
            JSON.stringify({
              access_token: "ghu_initial",
              expires_in: 28800,
              refresh_token: "ghr_initial",
              refresh_token_expires_in: 15897600,
              scope: "repo,user:email",
              token_type: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (String(url) === "https://api.github.com/user") {
          return new Response(
            JSON.stringify({
              id: 583231,
              login: "octocat",
              name: "Octo Cat",
              email: "octo@example.com",
              avatar_url: "https://github.com/avatars/octocat.png",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      };
      const result = await exchangeCodeForAppUserProfile(
        {
          clientId: "cid",
          clientSecret: "csec",
          code: "code-from-callback",
          redirectUri: "https://first-tree.example.com/cb",
          installationId: 9999,
        },
        { fetcher: fakeFetch, now: () => fixedNow },
      );
      // The token-exchange POST and the /user GET — no /user/emails because
      // the profile carried a public email.
      expect(calls).toHaveLength(2);
      expect(calls[0]?.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        client_id: "cid",
        client_secret: "csec",
        code: "code-from-callback",
        redirect_uri: "https://first-tree.example.com/cb",
      });
      expect(result.profile).toEqual({
        githubId: "583231",
        login: "octocat",
        email: "octo@example.com",
        displayName: "Octo Cat",
        avatarUrl: "https://github.com/avatars/octocat.png",
      });
      expect(result.accessToken).toBe("ghu_initial");
      expect(result.accessTokenExpiresAt).toBe("2026-05-11T18:00:00.000Z");
      expect(result.refreshToken).toBe("ghr_initial");
      expect(result.refreshTokenExpiresAt).toBe("2026-11-11T10:00:00.000Z");
      expect(result.installationId).toBe(9999);
    });

    it("falls back to /user/emails when the profile hides the primary email", async () => {
      const fakeFetch: typeof fetch = async (url) => {
        if (String(url) === "https://github.com/login/oauth/access_token") {
          return new Response(
            JSON.stringify({
              access_token: "a",
              expires_in: 28800,
              refresh_token: "r",
              refresh_token_expires_in: 15897600,
              scope: "",
              token_type: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (String(url) === "https://api.github.com/user") {
          return new Response(JSON.stringify({ id: 1, login: "u", email: null, name: null, avatar_url: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url) === "https://api.github.com/user/emails") {
          return new Response(
            JSON.stringify([
              { email: "secondary@example.com", primary: false, verified: true },
              { email: "primary@example.com", primary: true, verified: true },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      };
      const result = await exchangeCodeForAppUserProfile(
        { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", installationId: null },
        { fetcher: fakeFetch, now: () => fixedNow },
      );
      expect(result.profile.email).toBe("primary@example.com");
      expect(result.installationId).toBeNull();
    });

    it("normalizes a 200-with-error body to a 401 GithubAppApiError", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ error: "bad_verification_code", error_description: "Wrong code." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      await expect(
        exchangeCodeForAppUserProfile(
          { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", installationId: null },
          { fetcher: fakeFetch },
        ),
      ).rejects.toMatchObject({ name: "GithubAppApiError", status: 401 });
    });

    it("rejects loudly when expires_in is missing (App misconfigured)", async () => {
      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ access_token: "a", refresh_token: "r", scope: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const err = (await exchangeCodeForAppUserProfile(
        { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", installationId: null },
        { fetcher: fakeFetch },
      ).catch((e: unknown) => e)) as GithubAppApiError;
      expect(err).toBeInstanceOf(GithubAppApiError);
      expect(err.status).toBe(500);
      expect(err.message).toContain("expires_in");
    });

    it("throws GithubAppApiError when the profile fetch fails", async () => {
      const fakeFetch: typeof fetch = async (url) => {
        if (String(url) === "https://github.com/login/oauth/access_token") {
          return new Response(
            JSON.stringify({
              access_token: "a",
              expires_in: 28800,
              refresh_token: "r",
              refresh_token_expires_in: 15897600,
              scope: "",
              token_type: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ message: "profile unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      };

      await expect(
        exchangeCodeForAppUserProfile(
          { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", installationId: null },
          { fetcher: fakeFetch },
        ),
      ).rejects.toMatchObject({ name: "GithubAppApiError", status: 503 });
    });
  });
});

describe("services/github-app › listInstallationRepos", () => {
  type FetchInput = Parameters<typeof fetch>[0];
  const urlOf = (input: FetchInput): string =>
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  function repo(name: string, pushedAt: string | null) {
    return {
      full_name: name,
      clone_url: `https://github.com/${name}.git`,
      html_url: `https://github.com/${name}`,
      private: true,
      default_branch: "main",
      pushed_at: pushedAt,
    };
  }

  it("maps the installation repo envelope and sorts most-recently-pushed first", async () => {
    const fetcher: typeof fetch = async (input) => {
      expect(urlOf(input)).toContain("/installation/repositories");
      return new Response(
        JSON.stringify({
          total_count: 2,
          repositories: [repo("acme/old", "2024-01-01T00:00:00Z"), repo("acme/new", "2025-01-01T00:00:00Z")],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const repos = await listInstallationRepos("ghs_token", { fetcher });
    expect(repos.map((r) => r.fullName)).toEqual(["acme/new", "acme/old"]);
    expect(repos[0]).toMatchObject({
      fullName: "acme/new",
      cloneUrl: "https://github.com/acme/new.git",
      htmlUrl: "https://github.com/acme/new",
      private: true,
      defaultBranch: "main",
      pushedAt: "2025-01-01T00:00:00Z",
    });
  });

  it("walks pages until a short page (and stops)", async () => {
    const calls: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      const page = Number(new URL(urlOf(input)).searchParams.get("page"));
      calls.push(page);
      // Page 1 full (100), page 2 short (1) → stop after page 2.
      const repositories =
        page === 1
          ? Array.from({ length: 100 }, (_, i) => repo(`acme/r${i}`, "2024-01-01T00:00:00Z"))
          : [repo("acme/last", "2024-02-01T00:00:00Z")];
      return new Response(JSON.stringify({ total_count: 101, repositories }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const repos = await listInstallationRepos("ghs_token", { fetcher });
    expect(calls).toEqual([1, 2]);
    expect(repos).toHaveLength(101);
  });

  it("throws GithubAppApiError on a non-2xx (e.g. suspended → 403)", async () => {
    const fetcher: typeof fetch = async () => new Response("forbidden", { status: 403 });
    await expect(listInstallationRepos("ghs_token", { fetcher })).rejects.toMatchObject({
      name: "GithubAppApiError",
      status: 403,
    });
  });

  it("stops at the maxPages cap even when every page is full", async () => {
    const calls: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      const page = Number(new URL(urlOf(input)).searchParams.get("page"));
      calls.push(page);
      // Always a full page (100) → only the maxPages cap can stop the walk.
      return new Response(
        JSON.stringify({
          total_count: 1000,
          repositories: Array.from({ length: 100 }, (_, i) => repo(`acme/p${page}-${i}`, "2024-01-01T00:00:00Z")),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const repos = await listInstallationRepos("ghs_token", { fetcher, maxPages: 3 });
    expect(calls).toEqual([1, 2, 3]);
    expect(repos).toHaveLength(300);
  });

  it("sorts repos with no pushedAt last", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          total_count: 3,
          repositories: [
            repo("acme/null", null),
            repo("acme/old", "2024-01-01T00:00:00Z"),
            repo("acme/new", "2025-01-01T00:00:00Z"),
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const repos = await listInstallationRepos("ghs_token", { fetcher });
    expect(repos.map((r) => r.fullName)).toEqual(["acme/new", "acme/old", "acme/null"]);
  });
});

describe("services/github-app › installation repository helpers", () => {
  type FetchInput = Parameters<typeof fetch>[0];
  const urlOf = (input: FetchInput): string =>
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  function repoBody(owner = "acme", name = "tree") {
    return {
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner },
      clone_url: `https://github.com/${owner}/${name}.git`,
      html_url: `https://github.com/${owner}/${name}`,
      private: true,
      default_branch: "main",
    };
  }

  it("creates an organization repo with an installation token and parses the repo shape", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: urlOf(input), init });
      return new Response(JSON.stringify(repoBody("acme", "team-context-tree")), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    const repo = await createOrganizationRepo(
      "ghs_token",
      { org: "acme", name: "team-context-tree", private: true, description: "Team Context Tree" },
      { fetcher },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/orgs/acme/repos");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer ghs_token");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "team-context-tree",
      private: true,
      auto_init: false,
      description: "Team Context Tree",
    });
    expect(repo).toMatchObject({
      name: "team-context-tree",
      fullName: "acme/team-context-tree",
      ownerLogin: "acme",
      cloneUrl: "https://github.com/acme/team-context-tree.git",
      htmlUrl: "https://github.com/acme/team-context-tree",
      private: true,
      defaultBranch: "main",
    });
  });

  it("reads a repository with an installation token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: urlOf(input), init });
      return new Response(JSON.stringify(repoBody("acme", "tree")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const repo = await getRepository("ghs_token", "acme", "tree", { fetcher });

    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/tree");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer ghs_token");
    expect(repo.fullName).toBe("acme/tree");
  });

  it("creates and verifies a repo file with an installation token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: urlOf(input), init });
      return new Response(JSON.stringify({ path: "NODE.md" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await getRepoFileWithToken(
      "ghs_token",
      { owner: "acme", repo: "tree", path: "NODE.md", branch: "main" },
      { fetcher },
    );
    await createRepoFileWithToken(
      "ghs_token",
      {
        owner: "acme",
        repo: "tree",
        path: "NODE.md",
        branch: "main",
        message: "Initialize Context Tree root node",
        contentBase64: "IyBUcmVlCg==",
      },
      { fetcher },
    );

    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/tree/contents/NODE.md?ref=main");
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/tree/contents/NODE.md");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      message: "Initialize Context Tree root node",
      content: "IyBUcmVlCg==",
      branch: "main",
    });
  });

  it("throws GithubAppApiError with status and upstream message on helper failures", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Repository creation failed." }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });

    await expect(
      createOrganizationRepo("ghs_token", { org: "acme", name: "tree", private: true }, { fetcher }),
    ).rejects.toMatchObject({
      name: "GithubAppApiError",
      status: 422,
      message: expect.stringContaining("Repository creation failed."),
    });
  });

  it("throws GithubAppApiError when GitHub repo helpers return invalid success bodies", async () => {
    await expect(
      getRepository("ghs_token", "acme", "tree", {
        fetcher: async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      }),
    ).rejects.toMatchObject({
      name: "GithubAppApiError",
      status: 502,
      message: expect.stringContaining("invalid response"),
    });

    await expect(
      createOrganizationRepo(
        "ghs_token",
        { org: "acme", name: "tree", private: true },
        {
          fetcher: async () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
        },
      ),
    ).rejects.toMatchObject({
      name: "GithubAppApiError",
      status: 502,
      message: expect.stringContaining("invalid response"),
    });
  });

  it("omits upstream detail when a JSON error body cannot be parsed", async () => {
    await expect(
      getRepoFileWithToken(
        "ghs_token",
        { owner: "acme", repo: "tree", path: "NODE.md", branch: "main" },
        {
          fetcher: async () =>
            new Response("not-json", { status: 500, headers: { "content-type": "application/json" } }),
        },
      ),
    ).rejects.toMatchObject({
      name: "GithubAppApiError",
      status: 500,
      message: "GitHub file fetch failed (500)",
    });
  });
});
