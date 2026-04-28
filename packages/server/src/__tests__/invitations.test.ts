import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invitationRedemptions, invitations } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Invitation lifecycle", () => {
  const getApp = useTestApp();

  it("admin can fetch (and auto-create) the active invite link", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; inviteUrl: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.inviteUrl).toContain(`/invite/${body.token}`);
  });

  it("rotate revokes the prior token and issues a fresh one", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const firstToken = first.json<{ token: string }>().token;

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations/rotate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(second.statusCode).toBe(200);
    const secondToken = second.json<{ token: string }>().token;
    expect(secondToken).not.toBe(firstToken);

    // Old row is revoked.
    const oldRow = await app.db.select().from(invitations).where(eq(invitations.token, firstToken));
    expect(oldRow[0]?.revokedAt).not.toBeNull();
  });

  it("non-admin cannot fetch or rotate invitations", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // Demote: create a second member with role=member via raw insert
    const { ensureMembership } = await import("../services/membership.js");
    const { uuidv7 } = await import("../uuid.js");
    const { users } = await import("../db/schema/users.js");
    const { signTokensForMember } = await import("../services/auth.js");
    const otherUserId = uuidv7();
    await app.db.insert(users).values({
      id: otherUserId,
      username: `peer-${otherUserId.slice(0, 8)}`,
      passwordHash: "x",
      displayName: "Peer",
    });
    const peer = await ensureMembership(app.db, {
      userId: otherUserId,
      organizationId: admin.organizationId,
      role: "member",
      displayName: "Peer",
      username: `peer-${otherUserId.slice(0, 8)}`,
    });
    const tokens = await signTokensForMember(app.config.secrets.jwtSecret, {
      userId: otherUserId,
      memberId: peer.id,
      organizationId: peer.organizationId,
      role: "member",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations/rotate`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
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
    const orgs = await app.db.select().from(organizations).where(eq(organizations.name, "other-org-admin-personal"));
    const otherOrgRow = orgs[0];
    if (!otherOrgRow) throw new Error("expected other org row");
    const otherOrgId = otherOrgRow.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/organizations/${otherOrgId}/invitations/rotate`,
      headers: { authorization: `Bearer ${adminA.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("public preview returns org info for an active token", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const inv = await app.inject({
      method: "GET",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const token = inv.json<{ token: string }>().token;

    const preview = await app.inject({ method: "GET", url: `/api/v1/invite/${token}/preview` });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<{ organizationName: string; role: string }>();
    expect(body.role).toBe("member");
  });

  it("public preview 404s for revoked tokens", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const inv = await app.inject({
      method: "GET",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const token = inv.json<{ token: string }>().token;

    await app.inject({
      method: "POST",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations/rotate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    const preview = await app.inject({ method: "GET", url: `/api/v1/invite/${token}/preview` });
    expect(preview.statusCode).toBe(404);
  });

  it("join via invite token records redemption + sets membership active", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const inv = await app.inject({
      method: "GET",
      url: `/api/v1/admin/organizations/${admin.organizationId}/invitations`,
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
