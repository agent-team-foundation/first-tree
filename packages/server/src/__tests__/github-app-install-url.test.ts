import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { signTokensForUser } from "../services/auth.js";
import { OAUTH_STATE_COOKIE, verifyOAuthState } from "../services/oauth-state.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";

/** Pull `oauth_state_nonce` out of a Set-Cookie header. */
function readStateCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const raw = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
  const m = new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`).exec(raw);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

describe("GET /api/v1/orgs/:orgId/github-app-installation/install-url", () => {
  const getApp = useTestApp();

  it("returns the GitHub installations/new URL + sets the state cookie", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/install-url`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ installUrl: string }>();
    const url = new URL(body.installUrl);
    expect(url.origin).toBe("https://github.com");
    // helpers.ts seeds slug="test-app-slug".
    expect(url.pathname).toBe("/apps/test-app-slug/installations/new");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    // The state cookie nonce matches the JWT — verifyOAuthState would
    // accept this pair when the callback fires.
    const cookieNonce = readStateCookie(res.headers["set-cookie"]);
    expect(cookieNonce).toBeTruthy();
    const verified = await verifyOAuthState(TEST_JWT_SECRET, state ?? "", cookieNonce);
    expect(verified.next).toBe("/settings/github");
    // The signed state pins both the org the install binds to AND the
    // kickoff admin whose (re-checked) authority the callback bind rests
    // on — the browser's github.com identity at callback time may differ.
    expect(verified.targetOrganizationId).toBe(admin.organizationId);
    expect(verified.kickoffUserId).toBe(admin.userId);
    expect(verified.intent).toBe("install");
    expect(verified.provider).toBe("github");
  });

  it("bakes an allowlisted ?next= into the signed state (onboarding flow)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/install-url?next=${encodeURIComponent("/onboarding")}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const state = new URL(res.json<{ installUrl: string }>().installUrl).searchParams.get("state");
    const cookieNonce = readStateCookie(res.headers["set-cookie"]);
    const verified = await verifyOAuthState(TEST_JWT_SECRET, state ?? "", cookieNonce);
    expect(verified.next).toBe("/onboarding");
  });

  it("ignores a ?next= that isn't on the allowlist (no open redirect)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/install-url?next=${encodeURIComponent("https://evil.example.com")}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const state = new URL(res.json<{ installUrl: string }>().installUrl).searchParams.get("state");
    const cookieNonce = readStateCookie(res.headers["set-cookie"]);
    const verified = await verifyOAuthState(TEST_JWT_SECRET, state ?? "", cookieNonce);
    expect(verified.next).toBe("/settings/github");
  });

  it("403s for a non-admin member of the org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Seed a second user joined to the same org with role "member".
    const memberUserId = uuidv7();
    const memberMemberId = uuidv7();
    const username = `member-${memberUserId.slice(0, 8)}`;
    const passwordHash = await bcrypt.hash("placeholder", 1);
    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({ id: memberUserId, username, passwordHash, displayName: "Member" });
      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `member-human-${memberUserId.slice(0, 8)}`,
        type: "human",
        displayName: "Member",
        managerId: memberMemberId,
        organizationId: admin.organizationId,
      });
      await tx.insert(members).values({
        id: memberMemberId,
        userId: memberUserId,
        organizationId: admin.organizationId,
        agentId: humanAgent.uuid,
        role: "member",
      });
    });
    const memberTokens = await signTokensForUser(TEST_JWT_SECRET, memberUserId, {
      accessTokenExpiry: "30m",
      refreshTokenExpiry: "30d",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/install-url`,
      headers: { authorization: `Bearer ${memberTokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s without a token", async () => {
    const app = getApp();
    const orgId = uuidv7();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/github-app-installation/install-url`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("install-url when the App slug is not configured", () => {
  // Same App creds as the default test app, minus `slug` — models a
  // deployment with sign-in/webhooks wired but no install URL.
  const getApp = useTestApp({ omitGithubAppSlug: true });

  it("503s with a slug-missing hint", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noslug-${crypto.randomUUID().slice(0, 8)}` });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/github-app-installation/install-url`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/FIRST_TREE_GITHUB_APP_SLUG/);
  });
});
