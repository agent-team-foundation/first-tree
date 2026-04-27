import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateInviteToken } from "../services/organization.js";
import { signOauthState } from "../services/auth-github.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * End-to-end tests for the SaaS auth surface added by PR #2:
 *
 *   * GET  /auth/github/start (dev mode)         — redirects to dev-callback
 *   * GET  /auth/github/dev-callback             — fakes a GitHub identity
 *   * GET  /me/workspaces (rootless user token)  — empty list for new user
 *   * POST /me/workspaces                        — creates workspace + admin member
 *   * POST /me/workspaces/join                   — joins via invite token (idempotent)
 *   * POST /auth/switch-org                      — re-issues per-org tokens
 *   * GET  /invite/:token/preview                — public landing-page data
 *
 * All tests run in dev mode (no FIRST_TREE_HUB_OAUTH_GITHUB_CLIENT_ID set in
 * the test config). The dev-callback path writes the same shape
 * `auth_providers` row a real GitHub callback would, so the rest of the flow
 * is identical to production.
 */
describe("SaaS auth — GitHub OAuth + workspaces + switch-org (dev mode)", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Sign in via the dev-callback, returning the issued token pair + the
   * `nextRoute` hint. Tests pass distinct `githubId`s so each call lands a
   * fresh user; reusing the same id is the documented "second sign-in"
   * idempotent path.
   */
  async function devSignIn(opts: {
    githubId: string;
    login?: string;
    email?: string;
    next?: string;
  }) {
    const next = opts.next ?? "/";
    const { state } = await signOauthState(app.config.secrets.jwtSecret, next);
    const params = new URLSearchParams({
      state,
      login: opts.login ?? `user-${opts.githubId}`,
      github_id: opts.githubId,
      email: opts.email ?? `${opts.login ?? `user-${opts.githubId}`}@example.local`,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?${params.toString()}`,
    });
    if (res.statusCode !== 200) {
      throw new Error(`dev sign-in failed (${res.statusCode}): ${res.body}`);
    }
    return res.json<{ accessToken: string; refreshToken: string; nextRoute: string }>();
  }

  it("dev sign-in for a brand-new user lands on /setup with a user-only token", async () => {
    const githubId = `${Date.now()}1`;
    const tokens = await devSignIn({ githubId, login: `newbie-${githubId}` });
    expect(tokens.nextRoute).toBe("/setup");
    expect(tokens.accessToken).toMatch(/^eyJ/);

    // Listing workspaces with the user-only token returns an empty array
    // (no /403 — the rootless token IS authorised here).
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("creating a workspace upgrades the caller to a per-org JWT and lands them as admin", async () => {
    const githubId = `${Date.now()}2`;
    const signIn = await devSignIn({ githubId, login: `creator-${githubId}` });

    const slug = `acme-${githubId}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${signIn.accessToken}` },
      payload: { name: slug, displayName: `Acme ${githubId}` },
    });
    expect(create.statusCode).toBe(200);
    const body = create.json<{
      workspace: { organizationId: string; memberId: string; role: string };
      accessToken: string;
      refreshToken: string;
    }>();
    expect(body.workspace.role).toBe("admin");
    expect(body.accessToken).not.toBe(signIn.accessToken);

    // The new per-org JWT now lists the workspace; the /me/workspaces route
    // accepts it because userAuthHook also passes type:"access" tokens.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: Array<{ organizationId: string; role: string }> }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.organizationId).toBe(body.workspace.organizationId);
    expect(items[0]?.role).toBe("admin");
  });

  it("join via invite link is idempotent and never opens a duplicate membership", async () => {
    // Seed a workspace + grab its real invite_token.
    const adminId = `${Date.now()}3a`;
    const adminSignIn = await devSignIn({ githubId: adminId, login: `admin-${adminId}` });
    const adminWs = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${adminSignIn.accessToken}` },
      payload: { name: `team-${adminId}`, displayName: `Team ${adminId}` },
    });
    const adminWsBody = adminWs.json<{ workspace: { organizationId: string } }>();
    const orgId = adminWsBody.workspace.organizationId;

    // Read the freshly generated invite_token straight from the DB — the
    // value isn't surfaced by any user-token route yet (PR #6).
    const { organizations } = await import("../db/schema/organizations.js");
    const { eq } = await import("drizzle-orm");
    const [orgRow] = await app.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const inviteToken = orgRow?.inviteToken ?? "";
    expect(inviteToken.length).toBeGreaterThan(20);

    // A second user joins.
    const joinerId = `${Date.now()}3b`;
    const joinerSignIn = await devSignIn({ githubId: joinerId, login: `joiner-${joinerId}` });

    // Pasting the bare token works.
    const join1 = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/join",
      headers: { authorization: `Bearer ${joinerSignIn.accessToken}` },
      payload: { tokenOrUrl: inviteToken },
    });
    expect(join1.statusCode).toBe(200);
    const join1Body = join1.json<{ alreadyMember: boolean; workspace: { organizationId: string } }>();
    expect(join1Body.alreadyMember).toBe(false);
    expect(join1Body.workspace.organizationId).toBe(orgId);

    // Pasting a full URL the second time hits the idempotent path.
    const join2 = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/join",
      headers: { authorization: `Bearer ${joinerSignIn.accessToken}` },
      payload: { tokenOrUrl: `https://hub.first-tree.ai/invite/${inviteToken}` },
    });
    expect(join2.statusCode).toBe(200);
    expect(join2.json<{ alreadyMember: boolean }>().alreadyMember).toBe(true);

    // Garbage input returns 400 with the design-doc string.
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/join",
      headers: { authorization: `Bearer ${joinerSignIn.accessToken}` },
      payload: { tokenOrUrl: "not a token at all !!!" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("Doesn't look like a valid invite link");

    // Token that doesn't match any workspace is 400 with the §4.4 wording.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/join",
      headers: { authorization: `Bearer ${joinerSignIn.accessToken}` },
      payload: { tokenOrUrl: generateInviteToken() },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain("This invite link isn't valid");
  });

  it("invite preview returns workspace name without authentication", async () => {
    const ownerId = `${Date.now()}4`;
    const ownerSignIn = await devSignIn({ githubId: ownerId, login: `owner-${ownerId}` });
    const ws = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${ownerSignIn.accessToken}` },
      payload: { name: `preview-${ownerId}`, displayName: `Preview ${ownerId}` },
    });
    const wsBody = ws.json<{ workspace: { organizationId: string } }>();
    const { organizations } = await import("../db/schema/organizations.js");
    const { eq } = await import("drizzle-orm");
    const [orgRow] = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, wsBody.workspace.organizationId))
      .limit(1);
    const token = orgRow?.inviteToken ?? "";

    // No Authorization header — public route.
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/invite/${token}/preview`,
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<{
      organizationDisplayName: string;
      organizationSlug: string;
    }>();
    expect(previewBody.organizationDisplayName).toBe(`Preview ${ownerId}`);
    expect(previewBody.organizationSlug).toBe(`preview-${ownerId}`);

    // Unknown token → 404 with the design-doc string mapped from NotFoundError.
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/invite/${generateInviteToken()}/preview`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("switch-org refuses to mint a token for a workspace the user isn't a member of", async () => {
    // User in workspace A asks to switch to workspace B (which they're not in).
    const userAId = `${Date.now()}5a`;
    const aSignIn = await devSignIn({ githubId: userAId, login: `swa-${userAId}` });
    const wsA = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${aSignIn.accessToken}` },
      payload: { name: `wsa-${userAId}`, displayName: `WSA ${userAId}` },
    });
    const aTokens = wsA.json<{ accessToken: string; workspace: { organizationId: string } }>();

    const userBId = `${Date.now()}5b`;
    const bSignIn = await devSignIn({ githubId: userBId, login: `swb-${userBId}` });
    const wsB = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${bSignIn.accessToken}` },
      payload: { name: `wsb-${userBId}`, displayName: `WSB ${userBId}` },
    });
    const bWorkspaceId = wsB.json<{ workspace: { organizationId: string } }>().workspace.organizationId;

    const cross = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-org",
      headers: { authorization: `Bearer ${aTokens.accessToken}` },
      payload: { organizationId: bWorkspaceId },
    });
    expect(cross.statusCode).toBe(403);

    // Switching to a workspace the user IS in returns fresh tokens.
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-org",
      headers: { authorization: `Bearer ${aTokens.accessToken}` },
      payload: { organizationId: aTokens.workspace.organizationId },
    });
    expect(ok.statusCode).toBe(200);
    const okBody = ok.json<{ accessToken: string; refreshToken: string }>();
    expect(okBody.accessToken).toMatch(/^eyJ/);
  });

  it("/start accepts only relative `next` paths (no open-redirect)", async () => {
    // Absolute URL is silently dropped to "/" so the redirect lands on the
    // dev-callback URL with `state` carrying next="/", not the attacker URL.
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/start?next=https://evil.example.com",
    });
    expect(start.statusCode).toBe(302);
    const location = start.headers.location ?? "";
    // dev-mode redirect lands on /api/v1/auth/github/dev-callback locally
    expect(location).toContain("/api/v1/auth/github/dev-callback");
    expect(location).not.toContain("evil.example.com");
  });

  it("dev-callback rejects a tampered state JWT", async () => {
    const tampered = "eyJhbGciOiJIUzI1NiJ9.aW52YWxpZA.bm9wZQ";
    const params = new URLSearchParams({
      state: tampered,
      login: "tamper",
      github_id: "999",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?${params.toString()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("signing in twice with the same GitHub id returns the same userId (no duplicate users)", async () => {
    const githubId = `${Date.now()}7`;
    const a = await devSignIn({ githubId, login: `repeat-${githubId}` });
    const b = await devSignIn({ githubId, login: `repeat-${githubId}-renamed` });

    // Both sessions should land on /setup (no membership) and return tokens
    // for the same underlying user. We verify equality by listing workspaces
    // — the empty list shape is the same for both, but more meaningfully,
    // creating a workspace with token `a` and then listing with token `b`
    // proves they reference the same user record.
    expect(a.nextRoute).toBe("/setup");
    expect(b.nextRoute).toBe("/setup");
    const slug = `dup-${githubId}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: slug, displayName: `Dup ${githubId}` },
    });
    expect(create.statusCode).toBe(200);

    // Token b was issued before the workspace existed (rootless), but it
    // points at the same userId — listing workspaces with it should now
    // return the workspace created via token a.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: Array<{ organizationName: string }> }>().items;
    expect(items.map((i) => i.organizationName)).toContain(slug);
  });

  it("next=/invite/<token> is preserved through dev sign-in", async () => {
    const githubId = `${Date.now()}8`;
    const tokens = await devSignIn({
      githubId,
      login: `deeplink-${githubId}`,
      next: "/invite/abcdef123",
    });
    // No membership + invite next → invite landing wins.
    expect(tokens.nextRoute).toBe("/invite/abcdef123");
  });

  it("/me/workspaces routes refuse a request with no Authorization header", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/me/workspaces/" });
    expect(list.statusCode).toBe(401);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      payload: { name: `nope-${uuidv7()}`, displayName: "Nope" },
    });
    expect(create.statusCode).toBe(401);
  });
});
