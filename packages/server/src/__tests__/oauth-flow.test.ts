import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

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

    // Personal team was minted.
    const orgs = await app.db.select().from(organizations).where(eq(organizations.name, "octocat-personal"));
    expect(orgs).toHaveLength(1);
    const orgRow = orgs[0];
    if (!orgRow) throw new Error("expected personal org row");

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

  it("disambiguates personal team slug on collision", async () => {
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
    const personals = orgs.filter((o) => o.name.startsWith("duplicate-personal"));
    expect(personals.length).toBeGreaterThanOrEqual(2);
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

  it("auto-binds legacy password user when github login matches username", async () => {
    const app = getApp();
    // Pre-OAuth user: bcrypt password + active membership, no auth_identities row.
    const legacy = await createTestAdmin(app, { username: "legacypal" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=12345&login=legacypal&displayName=Legacy+Pal",
    });
    expect(res.statusCode).toBe(302);

    // The new auth_identity is bound to the existing legacy user — not a fresh one.
    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "12345"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.userId).toBe(legacy.userId);
    expect((ids[0]?.metadata as Record<string, unknown> | null)?.migratedFrom).toBe("legacy_password");

    // No second user — username remains unique.
    const dupes = await app.db.select().from(users).where(eq(users.username, "legacypal"));
    expect(dupes).toHaveLength(1);

    // joinPath is "returning" because the legacy user already has a membership.
    const fragment = res.headers.location?.split("#")[1] ?? "";
    expect(new URLSearchParams(fragment).get("joinPath")).toBe("returning");
  });

  it("matches legacy username case-insensitively", async () => {
    const app = getApp();
    const legacy = await createTestAdmin(app, { username: "MixedCase" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=999&login=mixedcase",
    });
    expect(res.statusCode).toBe(302);

    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "999"));
    expect(ids[0]?.userId).toBe(legacy.userId);
  });

  it("does not auto-bind a different github account to a user already bound", async () => {
    const app = getApp();
    // First sign-in mints a fresh user `dupelogin` and binds githubId=100.
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=100&login=dupelogin",
    });

    // A second GitHub account whose login matches the existing user's username
    // must NOT take over — `findOrCreateUserFromGithub` requires the legacy
    // user to have ZERO github identities. We expect a brand-new user, with
    // username disambiguated by the existing collision-retry path.
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=200&login=dupelogin",
    });

    const both = await app.db.select().from(authIdentities).where(eq(authIdentities.provider, "github"));
    const u100 = both.find((i) => i.identifier === "100")?.userId;
    const u200 = both.find((i) => i.identifier === "200")?.userId;
    expect(u100).toBeDefined();
    expect(u200).toBeDefined();
    expect(u100).not.toBe(u200);
  });

  it("does not auto-bind a suspended legacy user", async () => {
    const app = getApp();
    // Legacy user that has been suspended — must NOT silently come back online
    // through OAuth. Creating + then suspending mirrors how an admin would
    // disable an account in production.
    const suspended = await createTestAdmin(app, { username: "banned" });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.userId));

    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=555&login=banned",
    });

    // The dev-callback creates a fresh user instead of binding the suspended one.
    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "555"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.userId).not.toBe(suspended.userId);
    // Suspended user remains identity-less.
    const suspendedIds = await app.db.select().from(authIdentities).where(eq(authIdentities.userId, suspended.userId));
    expect(suspendedIds).toHaveLength(0);
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

    // Direct INSERT bypassing the service layer — simulates the race window
    // (two concurrent legacy binds) the partial unique index is meant to
    // close. The DB must reject the second row regardless of whether the
    // service layer would have caught it.
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
