import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
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

  it("returns 403 scope_missing deterministically when GitHub returns 401 (mocked, no network)", async () => {
    const app = getApp();
    // Seed an OAuth user with a real encrypted token. The token value
    // doesn't matter — we stub `globalThis.fetch` to deterministically
    // return 401 for any github.com call, exercising the
    // GithubApiError(401) → 403 scope_missing branch independently of
    // network reachability (the prior test accepts [403, 502, 503] to
    // stay green in air-gapped CI; this one pins the 403 path).
    const dev = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=9002&login=tokentest401",
    });
    const fragment = dev.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    expect(access).toBeTruthy();

    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "9002")).limit(1);
    if (!identity) throw new Error("expected auth identity");
    const encrypted = encryptValue("any_token_we_will_intercept", app.config.secrets.encryptionKey);
    await app.db
      .update(authIdentities)
      .set({ metadata: { ...(identity.metadata ?? {}), accessToken: encrypted } })
      .where(eq(authIdentities.id, identity.id));

    const originalFetch = globalThis.fetch;
    type FetchInput = Parameters<typeof globalThis.fetch>[0];
    type FetchInit = Parameters<typeof globalThis.fetch>[1];
    const fetchSpy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.github.com")) {
        return new Response("Bad credentials", { status: 401 });
      }
      return originalFetch(input, init);
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me/github/repos",
        headers: { authorization: `Bearer ${access}` },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: string; code: string }>();
      expect(body.code).toBe("scope_missing");
      expect(body.error).not.toMatch(/Bad credentials/i);
      expect(body.error).toMatch(/reconnect/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("POST /me/onboarding/events", () => {
  const getApp = useTestApp();

  it("rejects forged event/userId smuggled in attrs (#248 codex review)", async () => {
    // Pre-fix the spread order was `{ event, userId, ...attrs }`, so a
    // hostile authenticated tab could POST
    //   attrs: { event: "fake.event", userId: "victim-uid" }
    // and have those values overwrite the JWT-derived `userId` and the
    // Zod-validated event in the structured log line, corrupting funnel
    // attribution.
    //
    // The fix flips the order to `{ ...attrs, event, userId }` so the
    // server-controlled fields always win. This test pins that behavior
    // by capturing the actual log payload via a vi spy on app.log.info.
    const app = getApp();
    const admin = await createTestAdmin(app);

    const captured: Array<Record<string, unknown>> = [];
    const infoSpy = vi.spyOn(app.log, "info").mockImplementation(((...args: unknown[]) => {
      const obj = args[0];
      if (obj && typeof obj === "object") captured.push(obj as Record<string, unknown>);
      return app.log;
    }) as typeof app.log.info);

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/onboarding/events",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {
          event: "agent_created",
          attrs: {
            event: "onboarding.fake_forged_event",
            userId: "attacker-controlled-user-id",
            extra: "legit-attr-keeps-working",
          },
        },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      infoSpy.mockRestore();
    }

    // Find the funnel line and confirm server-controlled fields stand.
    const funnelEntry = captured.find((c) => typeof c.event === "string" && String(c.event).startsWith("onboarding."));
    expect(funnelEntry).toBeDefined();
    expect(funnelEntry?.event).toBe("onboarding.agent_created");
    expect(funnelEntry?.userId).toBe(admin.userId);
    // Non-conflicting attrs keys must still flow through — the schema lets
    // callers attach arbitrary primitives for funnel context.
    expect(funnelEntry?.extra).toBe("legit-attr-keeps-working");
  });

  it("rejects unauthenticated callers", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding/events",
      payload: { event: "agent_created" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unknown event names with 400 (Zod enum)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding/events",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { event: "totally_made_up_event" },
    });
    expect(res.statusCode).toBe(400);
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
    const body = me.json<{
      onboarding: { step: string; dismissedAt: string | null; completedAt: string | null };
    }>();
    expect(body.onboarding.step).toBe("connect");
    expect(body.onboarding.dismissedAt).toBeNull();
    expect(body.onboarding.completedAt).toBeNull();
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

describe("POST /me/onboarding-completed", () => {
  const getApp = useTestApp();

  it("stamps onboarding_completed_at and /me reflects it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(before.json<{ onboarding: { completedAt: string | null } }>().onboarding.completedAt).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(after.json<{ onboarding: { completedAt: string | null } }>().onboarding.completedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("is idempotent — second call leaves the original timestamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    const firstMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const firstStamp = firstMe.json<{ onboarding: { completedAt: string } }>().onboarding.completedAt;

    // Sleep a tick so server-side NOW() would advance if the second POST
    // re-stamped the column.
    await new Promise((r) => setTimeout(r, 10));

    await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    const secondMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(secondMe.json<{ onboarding: { completedAt: string } }>().onboarding.completedAt).toBe(firstStamp);
  });

  it("does NOT touch onboarding_dismissed_at — the two stamps are orthogonal", async () => {
    // Terminal completion and stepper-✕ are decoupled by design: dismiss
    // = "hide the stepper UI" (reversible), completed = "setup done"
    // (permanent). The POST must not double-stamp the dismiss column;
    // otherwise a user who completed Step 3 without ever clicking ✕
    // would surface as dismissed=true to other UI surfaces that still
    // read that field.
    const app = getApp();
    const admin = await createTestAdmin(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(before.json<{ onboarding: { dismissedAt: string | null } }>().onboarding.dismissedAt).toBeNull();

    await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(after.json<{ onboarding: { dismissedAt: string | null } }>().onboarding.dismissedAt).toBeNull();
  });

  it("rejects unauthenticated callers", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /me — per-membership hasUsableAgent", () => {
  const getApp = useTestApp();

  type MeMembershipsBody = { memberships: Array<{ organizationId: string; hasUsableAgent: boolean }> };

  it("is false for a fresh org (only the seeded human agent), true once a non-human agent exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const beforeRow = before
      .json<MeMembershipsBody>()
      .memberships.find((m) => m.organizationId === admin.organizationId);
    expect(beforeRow?.hasUsableAgent).toBe(false);

    // Drop in a non-human agent the admin manages (private — own agents
    // count regardless of visibility).
    const uuid = crypto.randomUUID();
    await app.db.insert(agents).values({
      uuid,
      name: `a-${uuid.slice(0, 8)}`,
      organizationId: admin.organizationId,
      type: "agent",
      displayName: "Assistant",
      inboxId: `inbox_${uuid}`,
      status: "active",
      visibility: "private",
      managerId: admin.memberId,
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const afterRow = after.json<MeMembershipsBody>().memberships.find((m) => m.organizationId === admin.organizationId);
    expect(afterRow?.hasUsableAgent).toBe(true);
  });
});
