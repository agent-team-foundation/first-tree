import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { encryptValue } from "../services/crypto.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("PATCH /me/onboarding", () => {
  const getApp = useTestApp();

  it("dismissed=true stamps onboarding_dismissed_at and /me reflects it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(before.json<{ onboarding: { dismissedAt: string | null } }>().onboarding.dismissedAt).toBeNull();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { dismissed: true },
    });
    expect(res.statusCode).toBe(200);
    const stamped = res.json<{ dismissedAt: string | null }>().dismissedAt;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(after.json<{ onboarding: { dismissedAt: string | null } }>().onboarding.dismissedAt).toBe(stamped);
  });

  it("dismissed=true is idempotent — second call leaves the original timestamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const first = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { dismissed: true },
    });
    const firstStamp = first.json<{ dismissedAt: string }>().dismissedAt;

    // Sleep a tick so server-side NOW() would advance if the second PATCH
    // re-stamped the column.
    await new Promise((r) => setTimeout(r, 10));

    const second = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { dismissed: true },
    });
    expect(second.json<{ dismissedAt: string }>().dismissedAt).toBe(firstStamp);
  });

  it("dismissed=false clears the timestamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { dismissed: true },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { dismissed: false },
    });
    expect(cleared.json<{ dismissedAt: string | null }>().dismissedAt).toBeNull();
  });

  it("rejects unauthenticated callers", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      payload: { dismissed: true },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /me/github/repos", () => {
  const getApp = useTestApp();

  it("returns 503 when the user has no encrypted GitHub access token", async () => {
    const app = getApp();
    // createTestAdmin doesn't go through the OAuth callback that captures
    // the token, so the `accessToken` metadata field is absent — the
    // endpoint should refuse politely rather than 500.
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/github/repos",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/reconnect/i);
  });

  it("returns 403 scope_missing when GitHub rejects the token (does not leak provider error)", async () => {
    const app = getApp();
    // Seed an OAuth user with a bogus encrypted token that decrypts to a
    // garbage string — `listUserRepos` will hit github.com which will
    // return 401 ("Bad credentials"). The handler classifies 401/403 as a
    // scope/auth issue and steers the user to the Reconnect path; the
    // assertion is that no provider string leaks and the response uses
    // our `code: scope_missing` contract.
    const dev = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=9001&login=tokentest",
    });
    const fragment = dev.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    expect(access).toBeTruthy();

    // Find the user we just minted and patch in an encrypted "fake_token"
    // that decrypts cleanly but won't authenticate to github.com.
    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "9001")).limit(1);
    if (!identity) throw new Error("expected auth identity");
    const encrypted = encryptValue("fake_token_will_get_401_from_github", app.config.secrets.encryptionKey);
    await app.db
      .update(authIdentities)
      .set({ metadata: { ...(identity.metadata ?? {}), accessToken: encrypted } })
      .where(eq(authIdentities.id, identity.id));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/github/repos",
      headers: { authorization: `Bearer ${access}` },
    });
    // 403 = GitHub rejected the token (typical: missing `repo` scope or
    // revoked token, both a "reconnect" affordance). 502 = made the call
    // but got a non-auth GitHub error. 503 = couldn't reach github.com
    // (air-gapped CI). All three are fine; the assertion is no leakage.
    expect([403, 502, 503]).toContain(res.statusCode);
    const body = res.json<{ error: string; code?: string }>();
    expect(body.error).not.toMatch(/Bad credentials/i);
    expect(body.error).not.toMatch(/GitHub repo list failed/i);
    if (res.statusCode === 403) {
      expect(body.code).toBe("scope_missing");
    }
  });
});

describe("/me onboarding payload", () => {
  const getApp = useTestApp();

  it("includes onboarding.dismissedAt as null on a fresh user", async () => {
    const app = getApp();
    // Fresh OAuth user — no admin pre-seed, no client/agent pre-seed,
    // no dismissal stamp.
    const oauth = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=9100&login=fresh-onb",
    });
    const fragment = oauth.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{ onboarding: { step: string; dismissedAt: string | null } }>();
    expect(body.onboarding.step).toBe("connect");
    expect(body.onboarding.dismissedAt).toBeNull();
  });

  it("includes onboarding.dismissedAt as a timestamp once the user dismisses", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Stamp directly via the column to avoid coupling this test to the
    // PATCH path (which has its own coverage above).
    await app.db.update(users).set({ onboardingDismissedAt: new Date() }).where(eq(users.id, admin.userId));

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const dismissedAt = me.json<{ onboarding: { dismissedAt: string | null } }>().onboarding.dismissedAt;
    expect(dismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
