import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { encryptValue } from "../services/crypto.js";
import * as githubUserToken from "../services/github-user-token.js";
import { createMember } from "../services/member.js";
import { ensureMembership } from "../services/membership.js";
import { createOrganization } from "../services/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("PATCH /me/onboarding", () => {
  const getApp = useTestApp();

  it("dismissed=true stamps only the selected membership and /me reflects it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const secondOrg = await createOrganization(app.db, {
      name: `second-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Second Team",
    });
    const secondMember = await createMember(app.db, secondOrg.id, {
      username: admin.username,
      displayName: "Test Admin",
      role: "member",
    });

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const beforeMemberships = before.json<{
      memberships: Array<{ id: string; onboardingSuppressedAt: string | null }>;
    }>().memberships;
    expect(beforeMemberships.find((m) => m.id === admin.memberId)?.onboardingSuppressedAt).toBeNull();
    expect(beforeMemberships.find((m) => m.id === secondMember.id)?.onboardingSuppressedAt).toBeNull();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { dismissed: true, organizationId: secondOrg.id },
    });
    expect(res.statusCode).toBe(200);
    const stamped = res.json<{ dismissedAt: string | null }>().dismissedAt;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const afterMemberships = after.json<{
      memberships: Array<{
        id: string;
        onboardingSuppressedAt: string | null;
        onboardingSuppressedReason: string | null;
      }>;
    }>().memberships;
    expect(afterMemberships.find((m) => m.id === admin.memberId)?.onboardingSuppressedAt).toBeNull();
    expect(afterMemberships.find((m) => m.id === secondMember.id)?.onboardingSuppressedAt).toBe(stamped);
    expect(afterMemberships.find((m) => m.id === secondMember.id)?.onboardingSuppressedReason).toBe("finish_later");
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

  it("completion writes audit and suppress stamps for the selected membership", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/onboarding-completed",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { organizationId: admin.organizationId },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const current = after
      .json<{
        memberships: Array<{
          id: string;
          onboardingSuppressedAt: string | null;
          onboardingSuppressedReason: string | null;
          onboardingCompletedAt: string | null;
        }>;
      }>()
      .memberships.find((m) => m.id === admin.memberId);
    expect(current?.onboardingCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(current?.onboardingSuppressedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(current?.onboardingSuppressedReason).toBe("completed");
  });

  it("rejoin starts a fresh onboarding lifecycle — reactivation clears all three stamps", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { ensureMembership } = await import("../services/membership.js");

    // Live through a full prior lifecycle: complete onboarding (stamps
    // completed + suppressed(reason='completed')), then leave the org.
    await app.db
      .update(members)
      .set({
        onboardingCompletedAt: new Date(),
        onboardingSuppressedAt: new Date(),
        onboardingSuppressedReason: "completed",
        status: "left",
      })
      .where(eq(members.id, admin.memberId));
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, admin.humanAgentUuid));

    // Rejoin (the invite-join / OAuth-invite path funnels through
    // ensureMembership): the row is reactivated, not recreated…
    const rejoined = await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: admin.organizationId,
      role: "member",
      displayName: "Test Admin",
      username: admin.username,
    });
    expect(rejoined.id).toBe(admin.memberId);
    expect(rejoined.status).toBe("active");
    // …and the onboarding lifecycle starts FRESH: a stale suppress stamp
    // must not hide setup for what is effectively a newly joined team.
    expect(rejoined.onboardingSuppressedAt).toBeNull();
    expect(rejoined.onboardingSuppressedReason).toBeNull();
    expect(rejoined.onboardingCompletedAt).toBeNull();

    const [row] = await app.db
      .select({
        suppressedAt: members.onboardingSuppressedAt,
        suppressedReason: members.onboardingSuppressedReason,
        completedAt: members.onboardingCompletedAt,
        status: members.status,
      })
      .from(members)
      .where(eq(members.id, admin.memberId));
    expect(row).toEqual({ suppressedAt: null, suppressedReason: null, completedAt: null, status: "active" });

    const [mirror] = await app.db
      .select({ status: agents.status, name: agents.name })
      .from(agents)
      .where(eq(agents.uuid, admin.humanAgentUuid));
    expect(mirror?.status).toBe("active");
    expect(mirror?.name).not.toBeNull();
  });

  it("ordinary membership rejoin does not restore an admin-removed member", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { ensureMembership } = await import("../services/membership.js");

    await app.db.update(members).set({ status: "removed" }).where(eq(members.id, admin.memberId));

    await expect(
      ensureMembership(app.db, {
        userId: admin.userId,
        organizationId: admin.organizationId,
        role: "member",
        displayName: "Test Admin",
        username: admin.username,
      }),
    ).rejects.toThrow(/removed by an admin/);
  });

  it("rejects a suppress timestamp without a suppress reason at the database boundary", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Drizzle wraps the postgres error ("Failed query: …") and keeps the
    // CHECK-violation detail on the error's `cause`, so assert against the
    // full chain rather than the wrapper message alone.
    const violation = await app.db
      .execute(sql`
        UPDATE members
        SET onboarding_suppressed_at = NOW(),
            onboarding_suppressed_reason = NULL
        WHERE id = ${admin.memberId}
      `)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(violation).not.toBeNull();
    const chain = `${violation}\n${violation instanceof Error ? String(violation.cause ?? "") : ""}`;
    expect(chain).toMatch(/members_onboarding_suppress_reason_check|check constraint/i);
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

  it("lets unexpected GitHub token errors flow to the generic error handler", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const token = vi
      .spyOn(githubUserToken, "getFreshGithubUserToken")
      .mockRejectedValueOnce(new Error("unexpected token store failure"));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me/github/repos",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json<{ error: string }>().error).toBe("Internal server error");
    } finally {
      token.mockRestore();
    }
  });

  it("returns repositories from a stored GitHub token", async () => {
    const app = getApp();
    const originalPat = process.env.DEV_GITHUB_PAT;
    process.env.DEV_GITHUB_PAT = "ghp_repo_success";
    const dev = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=9004&login=tokentest200",
    });
    if (originalPat === undefined) {
      delete process.env.DEV_GITHUB_PAT;
    } else {
      process.env.DEV_GITHUB_PAT = originalPat;
    }
    const fragment = dev.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    expect(access).toBeTruthy();

    const originalFetch = globalThis.fetch;
    type FetchInput = Parameters<typeof globalThis.fetch>[0];
    type FetchInit = Parameters<typeof globalThis.fetch>[1];
    const fetchSpy = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.github.com/user/repos")) {
        return new Response(
          JSON.stringify([
            {
              full_name: "acme/repo",
              clone_url: "https://github.com/acme/repo.git",
              html_url: "https://github.com/acme/repo",
              private: true,
              default_branch: "main",
              pushed_at: "2026-01-01T00:00:00Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      expect(res.statusCode).toBe(200);
      expect(res.json<{ repos: Array<{ fullName: string }> }>().repos).toEqual([
        expect.objectContaining({ fullName: "acme/repo" }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs and returns a stable reconnect error when the stored token cannot be decrypted", async () => {
    const app = getApp();
    const dev = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=9005&login=tokentestbadcipher",
    });
    const fragment = dev.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    expect(access).toBeTruthy();

    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "9005")).limit(1);
    if (!identity) throw new Error("expected auth identity");
    await app.db
      .update(authIdentities)
      .set({ metadata: { ...(identity.metadata ?? {}), accessToken: "enc:v1:not-valid" } })
      .where(eq(authIdentities.id, identity.id));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/github/repos",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/decoded|reconnect/i);
  });

  it("returns a stable 502 when GitHub repo listing fails for a non-auth upstream error", async () => {
    const app = getApp();
    const dev = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=9003&login=tokentest500",
    });
    const fragment = dev.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    expect(access).toBeTruthy();

    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "9003")).limit(1);
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
        return new Response("Server exploded", { status: 500 });
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
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toBe(
        "Couldn't reach GitHub. Try again, or reconnect your GitHub account.",
      );
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
          event: "step_viewed",
          attrs: {
            event: "onboarding.fake_forged_event",
            userId: "attacker-controlled-user-id",
            step: "connect-computer",
            path: "admin",
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
    expect(funnelEntry?.event).toBe("onboarding.step_viewed");
    expect(funnelEntry?.userId).toBe(admin.userId);
    expect(funnelEntry?.step).toBe("connect-computer");
    expect(funnelEntry?.path).toBe("admin");
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

  it("includes onboarding.dismissedAt as the default membership suppress stamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Stamp directly via the membership columns to avoid coupling this test to the
    // PATCH path (which has its own coverage above).
    await app.db
      .update(members)
      .set({ onboardingSuppressedAt: new Date(), onboardingSuppressedReason: "finish_later" })
      .where(eq(members.id, admin.memberId));

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

  it("completion suppresses future auto-open with reason=completed", async () => {
    // Terminal completion is now the canonical "do not auto-open again"
    // suppressor for this membership. `completed_at` remains the audit fact;
    // `suppressed_at(reason='completed')` is the redirect gate.
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
    const body = after.json<{
      onboarding: { dismissedAt: string | null; completedAt: string | null };
      memberships: Array<{
        id: string;
        onboardingSuppressedAt: string | null;
        onboardingSuppressedReason: string | null;
        onboardingCompletedAt: string | null;
      }>;
    }>();
    expect(body.onboarding.dismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.onboarding.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const current = body.memberships.find((m) => m.id === admin.memberId);
    expect(current?.onboardingSuppressedReason).toBe("completed");
    expect(current?.onboardingSuppressedAt).toBe(body.onboarding.dismissedAt);
    expect(current?.onboardingCompletedAt).toBe(body.onboarding.completedAt);
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

  type MeMembershipsBody = {
    memberships: Array<{ organizationId: string; hasUsableAgent: boolean; hasPersonalAgent: boolean }>;
  };

  it("keeps usable and personal agent readiness separate", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const other = await createTestAdmin(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const beforeRow = before
      .json<MeMembershipsBody>()
      .memberships.find((m) => m.organizationId === admin.organizationId);
    expect(beforeRow?.hasUsableAgent).toBe(false);
    expect(beforeRow?.hasPersonalAgent).toBe(false);

    const otherMember = await ensureMembership(app.db, {
      userId: other.userId,
      organizationId: admin.organizationId,
      username: `member-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Other Member",
      role: "member",
    });

    const sharedUuid = crypto.randomUUID();
    await app.db.insert(agents).values({
      uuid: sharedUuid,
      name: `shared-${sharedUuid.slice(0, 8)}`,
      organizationId: admin.organizationId,
      type: "agent",
      displayName: "Shared Assistant",
      inboxId: `inbox_${sharedUuid}`,
      status: "active",
      visibility: "organization",
      managerId: otherMember.id,
    });

    const afterShared = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const sharedRow = afterShared
      .json<MeMembershipsBody>()
      .memberships.find((m) => m.organizationId === admin.organizationId);
    expect(sharedRow?.hasUsableAgent).toBe(true);
    expect(sharedRow?.hasPersonalAgent).toBe(false);

    // Drop in a non-human agent the admin manages (private — own agents
    // count for personal readiness regardless of visibility).
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
    expect(afterRow?.hasPersonalAgent).toBe(true);
  });
});
