import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invitationRedemptions, invitations } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { createTestAdmin, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

describe("Invitation lifecycle", () => {
  const getApp = useTestApp();

  it("admin can fetch (and auto-create) the active invite link with default 7-day expiry", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; inviteUrl: string; expiresAt: string | null }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.inviteUrl).toContain(`/invite/${body.token}`);

    // Default 7-day TTL; allow a generous window for clock drift between
    // the test process and the in-process server.
    if (!body.expiresAt) throw new Error("expected expiresAt to be set");
    const expiresMs = new Date(body.expiresAt).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it("ensureActiveInvitation rotates past an expired-but-not-revoked row", async () => {
    // Reproduces the scenario where a prior invitation has aged past its
    // expiry but no admin has rotated yet. Bare INSERT would have tripped
    // `uq_invitations_active_per_org` (the partial unique can't filter on
    // now()); ensureActive's delegation to rotate handles it.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { ensureActiveInvitation, getActiveInvitation } = await import("../services/invitation.js");
    const { uuidv7 } = await import("../uuid.js");

    // Plant an expired row by hand — same shape as a stale rotation.
    const expiredId = uuidv7();
    const expiredToken = `expired-${expiredId}`;
    await app.db.insert(invitations).values({
      id: expiredId,
      organizationId: admin.organizationId,
      token: expiredToken,
      role: "member",
      createdBy: admin.userId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const fresh = await ensureActiveInvitation(app.db, admin.organizationId, admin.userId);
    expect(fresh.token).not.toBe(expiredToken);
    if (!fresh.expiresAt) throw new Error("rotated invitation should have a default expiry");
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Old row got revoked as part of the same rotate transaction.
    const oldRow = await app.db.select().from(invitations).where(eq(invitations.id, expiredId));
    expect(oldRow[0]?.revokedAt).not.toBeNull();

    // Active = the new one.
    const active = await getActiveInvitation(app.db, admin.organizationId);
    expect(active?.id).toBe(fresh.id);
  });

  it("rotate revokes the prior token and issues a fresh one", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const firstToken = first.json<{ token: string }>().token;

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/invitations/rotate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(second.statusCode).toBe(200);
    const secondToken = second.json<{ token: string }>().token;
    expect(secondToken).not.toBe(firstToken);

    // Old row is revoked.
    const oldRow = await app.db.select().from(invitations).where(eq(invitations.token, firstToken));
    expect(oldRow[0]?.revokedAt).not.toBeNull();
  });

  it("non-admin member can fetch/share the link but cannot rotate it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // Demote: create a second member with role=member via raw insert
    const { ensureMembership } = await import("../services/membership.js");
    const { uuidv7 } = await import("../uuid.js");
    const { users } = await import("../db/schema/users.js");
    const { signTokensForUser } = await import("../services/auth.js");
    const otherUserId = uuidv7();
    await app.db.insert(users).values({
      id: otherUserId,
      username: `peer-${otherUserId.slice(0, 8)}`,
      passwordHash: INVALID_BCRYPT_PLACEHOLDER,
      displayName: "Peer",
    });
    await ensureMembership(app.db, {
      userId: otherUserId,
      organizationId: admin.organizationId,
      role: "member",
      displayName: "Peer",
      username: `peer-${otherUserId.slice(0, 8)}`,
    });
    const tokens = await signTokensForUser(app.config.secrets.jwtSecret, otherUserId, app.config.auth);

    // Sharing the link is member-level: GET succeeds and returns the active link.
    const fetchRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(fetchRes.statusCode).toBe(200);
    const body = fetchRes.json<{ token: string; inviteUrl: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.inviteUrl).toContain(`/invite/${body.token}`);

    // Rotation is destructive and stays admin-only: member is refused.
    const rotateRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/invitations/rotate`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(rotateRes.statusCode).toBe(403);
  });

  it("admin from org A cannot rotate invitations of org B", async () => {
    const app = getApp();
    const adminA = await createTestAdmin(app, { username: `a-${crypto.randomUUID().slice(0, 6)}` });
    // Spin up a second org via OAuth dev-callback to keep its membership clean.
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=999&login=other-org-admin",
    });
    const { organizations } = await import("../db/schema/organizations.js");
    const orgs = await app.db.select().from(organizations).where(eq(organizations.name, "other-org-admin"));
    const otherOrgRow = orgs[0];
    if (!otherOrgRow) throw new Error("expected other org row");
    const otherOrgId = otherOrgRow.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${otherOrgId}/invitations/rotate`,
      headers: { authorization: `Bearer ${adminA.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("public preview returns org info for an active token", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const inv = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const token = inv.json<{ token: string }>().token;

    const preview = await app.inject({ method: "GET", url: `/api/v1/invitations/${token}/preview` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    const body = preview.json<{ organizationName: string; role: string; expiresAt: string | null }>();
    expect(body.role).toBe("member");
    // expiresAt is exposed so the invite page can render an "Expires in N days" hint.
    // Default invitations carry a 7-day TTL (services/invitation.ts), so this is a string,
    // not null. Parse to verify it's a valid future ISO timestamp.
    expect(typeof body.expiresAt).toBe("string");
    if (body.expiresAt) {
      const parsed = Date.parse(body.expiresAt);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(Date.now());
    }
  });

  it("public preview 404s for revoked tokens", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const inv = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const token = inv.json<{ token: string }>().token;

    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/invitations/rotate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    const preview = await app.inject({ method: "GET", url: `/api/v1/invitations/${token}/preview` });
    expect(preview.statusCode).toBe(404);
    expect(preview.headers["cache-control"]).toBe("no-store");
  });

  it("join via invite token records redemption + sets membership active", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const inv = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const token = inv.json<{ token: string }>().token;

    // Newcomer arrives via the OAuth dev-callback with `next=/invite/<token>`.
    const oauth = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=88&login=newhire&next=${encodeURIComponent(`/invite/${token}`)}`,
    });
    expect(oauth.statusCode).toBe(302);

    const memberRows = await app.db.select().from(members).where(eq(members.organizationId, admin.organizationId));
    // admin + newhire = 2 active members in the team
    expect(memberRows.filter((m) => m.status === "active").length).toBeGreaterThanOrEqual(2);

    const reds = await app.db.select().from(invitationRedemptions);
    expect(reds.length).toBeGreaterThanOrEqual(1);
  });
});
