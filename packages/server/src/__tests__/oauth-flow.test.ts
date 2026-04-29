import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { useTestApp } from "./helpers.js";

/**
 * End-to-end tests for the public GitHub-OAuth onboarding surface.
 * Uses `/auth/github/dev-callback` to skip the github.com round-trip —
 * the dev callback is identical to the live one once the GitHub profile
 * has been resolved.
 */
describe("GitHub OAuth onboarding flow", () => {
  const getApp = useTestApp();

  it("dev-callback creates user + auth_identity + personal team for first sign-in", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=42&login=octocat&displayName=Octo+Cat",
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("/auth/github/complete#");
    expect(location).toContain("access=");
    expect(location).toContain("refresh=");
    // First-time signup lands on dashboard; the onboarding modal layers on top.
    const fragment = location.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("next")).toBe("/");
    expect(params.get("joinPath")).toBe("solo");

    // Auth identity is recorded.
    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "42"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.provider).toBe("github");

    // Default team was minted — slug is the GitHub login (no `-personal` suffix).
    const orgs = await app.db.select().from(organizations).where(eq(organizations.name, "octocat"));
    expect(orgs).toHaveLength(1);
    const orgRow = orgs[0];
    if (!orgRow) throw new Error("expected default org row");
    // Display name is the GitHub real name, not "<user>'s Personal Team".
    expect(orgRow.displayName).toBe("Octo Cat");

    // The new user is its admin.
    const memberRows = await app.db.select().from(members).where(eq(members.organizationId, orgRow.id));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.role).toBe("admin");
    expect(memberRows[0]?.status).toBe("active");
  });

  it("second sign-in for same github id reuses the user", async () => {
    const app = getApp();
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=99&login=alice",
    });
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=99&login=alice",
    });
    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "99"));
    expect(ids).toHaveLength(1);
  });

  it("disambiguates default team slug on collision", async () => {
    const app = getApp();
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=1&login=duplicate",
    });
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=2&login=duplicate",
    });
    const orgs = await app.db.select().from(organizations);
    // First sign-in claims `duplicate`; second gets `duplicate-XXXX` (4-char hex).
    const claims = orgs.filter((o) => o.name === "duplicate" || /^duplicate-[a-f0-9]{4}$/.test(o.name));
    expect(claims.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects /dev-callback in production", async () => {
    const app = getApp();
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=7&login=prod",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("partial unique index forbids a single user from holding two github identities", async () => {
    const app = getApp();
    // Sign in once to create a user + bind githubId=700.
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=700&login=alphaone",
    });
    const [first] = await app.db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(eq(authIdentities.identifier, "700"));
    const userId = first?.userId;
    expect(userId).toBeDefined();
    if (!userId) throw new Error("seed identity missing");

    // Direct INSERT bypassing the service layer — verifies the storage-layer
    // guarantee that one user cannot hold two github identities, regardless
    // of whether any application-layer flow ever attempts it.
    const { authIdentities: ai } = await import("../db/schema/auth-identities.js");
    const { uuidv7 } = await import("../uuid.js");
    await expect(
      app.db.insert(ai).values({
        id: uuidv7(),
        userId,
        provider: "github",
        identifier: "701",
        email: null,
        verifiedAt: new Date(),
        metadata: { login: "alphaone-shadow" },
      }),
    ).rejects.toThrow();
  });

  it("issues tokens that authenticate /me", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=11&login=bob&displayName=Bob",
    });
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    const access = params.get("access");
    expect(access).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      member: { role: string; organizationId: string };
      wizard: { step: string };
    }>();
    expect(body.member.role).toBe("admin");
    expect(body.wizard.step).toBe("connect");
  });
});

describe("OAuth callback rejects malformed state", () => {
  const getApp = useTestApp();

  it("returns 401 when state JWT is gibberish", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/callback?code=abc&state=not-a-jwt",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when state cookie is absent", async () => {
    const app = getApp();
    // Sign a real state token but omit the cookie — should fail nonce check.
    const { signOAuthState } = await import("../services/oauth-state.js");
    const { token } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=abc&state=${token}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when cookie nonce mismatches", async () => {
    const app = getApp();
    const { signOAuthState } = await import("../services/oauth-state.js");
    const { token } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=abc&state=${token}`,
      headers: { cookie: "oauth_state_nonce=wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("dev-callback ignores open-redirect bypasses in `next`", async () => {
    const app = getApp();
    // `next=//evil.com` should be sanitized; first-time signup lands on `/`.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=55&login=evilnext&next=//evil.com",
    });
    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("next")).toBe("/");
  });
});
