import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { invitationRedemptions } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
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

    // Default team was minted — slug is the GitHub login (no `-personal` suffix).
    const orgs = await app.db.select().from(organizations).where(eq(organizations.name, "octocat"));
    expect(orgs).toHaveLength(1);
    const orgRow = orgs[0];
    if (!orgRow) throw new Error("expected default org row");
    // Default team display name is `${login}'s team` — collective-space
    // reading per first-tree-context:agent-hub/onboarding.md (was §5.5 in source design); user can rename
    // in onboarding Step 1.
    expect(orgRow.displayName).toBe("octocat's team");

    // The callback carries the resolved org back so the web selects it
    // (overriding any stale localStorage org) — here the freshly-minted team.
    expect(params.get("org")).toBe(orgRow.id);

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

  it("rejects /dev-callback when FIRST_TREE_DEV_CALLBACK_ENABLED is unset (codex P1-9)", async () => {
    // Models a misconfigured non-prod deploy where the operator just
    // happens not to have NODE_ENV=production set (typo, fresh staging
    // box, self-host first boot, etc.). The route used to be reachable
    // in this state; after the hardening, it 404s unless explicitly
    // opted-in via the env var.
    const app = getApp();
    const original = process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    delete process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=8&login=oops",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      if (original !== undefined) process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = original;
    }
  });

  it("rejects /dev-callback when FIRST_TREE_DEV_CALLBACK_ENABLED is set to something other than '1' / 'true'", async () => {
    const app = getApp();
    const original = process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    // Truthy-looking but not in the allow-list (e.g. operator wrote "yes").
    process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = "yes";
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=9&login=yes",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      if (original !== undefined) {
        process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = original;
      } else {
        delete process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
      }
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
      memberships: Array<{ role: string; organizationId: string }>;
      defaultOrganizationId: string | null;
      onboarding: { step: string };
    }>();
    // Solo signup auto-provisions one org with admin role.
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]?.role).toBe("admin");
    expect(body.defaultOrganizationId).toBe(body.memberships[0]?.organizationId);
    expect(body.onboarding.step).toBe("connect");
  });
});

describe("GitHub OAuth invite-only single-org entry gate", () => {
  const allowedOrganizationId = "org-entry-gate-allowed";
  const blockedOrganizationId = "org-entry-gate-blocked";
  const getApp = useTestApp({ allowedOrganizationId });

  async function ensureOrg(app: ReturnType<typeof getApp>, id: string, name: string): Promise<void> {
    const [existing] = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, id));
    if (existing) return;
    await app.db.insert(organizations).values({ id, name, displayName: name });
  }

  async function rotateInviteForOrg(app: ReturnType<typeof getApp>, organizationId: string) {
    const admin = await createTestAdmin(app, { username: `gate-admin-${randomUUID().slice(0, 8)}` });
    const { rotateInvitation } = await import("../services/invitation.js");
    return rotateInvitation(app.db, organizationId, admin.userId);
  }

  async function findGithubUserId(app: ReturnType<typeof getApp>, githubId: string): Promise<string> {
    const [identity] = await app.db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(eq(authIdentities.identifier, githubId));
    if (!identity) throw new Error(`expected github identity ${githubId}`);
    return identity.userId;
  }

  it("allows invite redemption for the configured organization", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    const invite = await rotateInviteForOrg(app, allowedOrganizationId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1201&login=allowedinvite&next=/invite/${invite.token}`,
    });

    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("joinPath")).toBe("invite");
    expect(params.get("next")).toBe("/");
    // The invited org is carried back in the fragment so the web makes it the
    // active selection instead of dropping the invitee into a stale org.
    expect(params.get("org")).toBe(allowedOrganizationId);

    const userId = await findGithubUserId(app, "1201");
    const memberRows = await app.db.select().from(members).where(eq(members.userId, userId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.organizationId).toBe(allowedOrganizationId);

    const redemptions = await app.db
      .select()
      .from(invitationRedemptions)
      .where(eq(invitationRedemptions.invitationId, invite.id));
    expect(redemptions).toHaveLength(1);
  });

  it("rejects invite redemption for other organizations before membership or redemption side effects", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    await ensureOrg(app, blockedOrganizationId, "blocked-entry-gate");
    const invite = await rotateInviteForOrg(app, blockedOrganizationId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1202&login=blockedinvite&next=/invite/${invite.token}`,
    });

    expect(res.statusCode).toBe(403);
    const userId = await findGithubUserId(app, "1202");
    const memberRows = await app.db.select().from(members).where(eq(members.userId, userId));
    expect(memberRows).toHaveLength(0);
    const redemptions = await app.db
      .select()
      .from(invitationRedemptions)
      .where(eq(invitationRedemptions.invitationId, invite.id));
    expect(redemptions).toHaveLength(0);
  });

  it("rejects new users without invite and does not create a personal team", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=1203&login=blockedsolo",
    });

    expect(res.statusCode).toBe(403);
    const userId = await findGithubUserId(app, "1203");
    const memberRows = await app.db.select().from(members).where(eq(members.userId, userId));
    expect(memberRows).toHaveLength(0);
    const orgRows = await app.db.select().from(organizations).where(eq(organizations.name, "blockedsolo"));
    expect(orgRows).toHaveLength(0);
  });

  it("allows existing members to return without an invite", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    const invite = await rotateInviteForOrg(app, allowedOrganizationId);
    await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1204&login=returninggate&next=/invite/${invite.token}`,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=1204&login=returninggate",
    });

    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("joinPath")).toBe("returning");
  });
});

describe("OAuth callback rejects malformed state", () => {
  const getApp = useTestApp();

  // The /callback route is a full-page browser navigation, so state
  // rejections redirect to the SPA's friendly error surface (the most
  // common trigger is a user spending >10min on GitHub's repo picker,
  // expiring the 10-minute state JWT) instead of stranding the browser
  // on a raw JSON 401.
  function expectStateRejectedRedirect(res: { statusCode: number; headers: { location?: string } }) {
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/auth/github/complete#");
    expect(res.headers.location).toContain("error=state-expired");
    expect(res.headers.location).not.toContain("access=");
  }

  it("redirects to the SPA error surface when state JWT is gibberish", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/callback?code=abc&state=not-a-jwt",
    });
    expectStateRejectedRedirect(res);
  });

  it("redirects to the SPA error surface when state cookie is absent", async () => {
    const app = getApp();
    // Sign a real state token but omit the cookie — should fail nonce check.
    const { signOAuthState } = await import("../services/oauth-state.js");
    const { token } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=abc&state=${token}`,
    });
    expectStateRejectedRedirect(res);
  });

  it("redirects to the SPA error surface when cookie nonce mismatches", async () => {
    const app = getApp();
    const { signOAuthState } = await import("../services/oauth-state.js");
    const { token } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=abc&state=${token}`,
      headers: { cookie: "oauth_state_nonce=wrong" },
    });
    expectStateRejectedRedirect(res);
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

  it("dev-callback stubs github_app_installations + binds to the new personal team when installationId is supplied", async () => {
    const app = getApp();
    const installationId = 8_810_001;
    const res = await app.inject({
      method: "GET",
      url:
        "/api/v1/auth/github/dev-callback?githubId=909&login=devappuser&displayName=Dev+App+User" +
        `&installationId=${installationId}&installationAccountType=User&installationAccountLogin=devappuser&installationAccountGithubId=909`,
    });
    expect(res.statusCode).toBe(302);

    const { findInstallationByGithubId } = await import("../services/github-app-installations.js");
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row).not.toBeNull();
    expect(row?.accountLogin).toBe("devappuser");
    expect(row?.accountType).toBe("User");
    // hub_organization_id is the freshly-minted personal team for the new
    // GitHub user — assert the binding by checking it's non-null. Verifying
    // the exact id would duplicate createPersonalTeam's slug derivation that
    // the earlier dev-callback test already pins down.
    expect(row?.hubOrganizationId).not.toBeNull();
    // App-declared permissions mirror D0b — the dev stub looks like a real
    // install for downstream QA.
    expect(row?.permissions).toMatchObject({
      administration: "write",
      contents: "write",
      workflows: "write",
      members: "read",
    });
  });

  it("dev-callback without installationId leaves github_app_installations untouched (legacy OAuth-only dev flow)", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=910&login=plainuser",
    });
    expect(res.statusCode).toBe(302);

    const { githubAppInstallations } = await import("../db/schema/github-app-installations.js");
    const rows = await app.db.select().from(githubAppInstallations);
    // No installation rows attributable to this synthetic GitHub id.
    const own = rows.filter((r) => r.accountGithubId === 910);
    expect(own).toHaveLength(0);
  });
});
