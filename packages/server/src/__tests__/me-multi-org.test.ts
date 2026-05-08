import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Multi-org self-service", () => {
  const getApp = useTestApp();

  it("GET /me/organizations lists active memberships", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<{ id: string; role: string }>>();
    expect(list.length).toBe(1);
    expect(list[0]?.role).toBe("admin");
  });

  it("POST /me/organizations creates a new team", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: `t-${crypto.randomUUID().slice(0, 8)}`, displayName: "Side Project" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ organization: { id: string; role: string } }>();
    expect(body.organization.role).toBe("admin");

    // Token unchanged — same userId. /me reflects the new membership.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ memberships: Array<{ organizationId: string }> }>();
    expect(meBody.memberships.some((m) => m.organizationId === body.organization.id)).toBe(true);
  });

  it("POST /me/memberships/:memberId/leave soft-deletes membership", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // Create a second team so leaving the first leaves the user with one membership.
    await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: `t-${crypto.randomUUID().slice(0, 8)}`, displayName: "Second" },
    });

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/v1/me/memberships/${admin.memberId}/leave`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(leaveRes.statusCode).toBe(204);

    // DB row is flipped to status='left'
    const rows = await app.db.select().from(members).where(eq(members.id, admin.memberId));
    expect(rows[0]?.status).toBe("left");

    // /me still works — token is keyed to userId, not memberId; the user
    // still has one active membership in the second team.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ memberships: Array<{ organizationId: string }> }>();
    expect(meBody.memberships.length).toBe(1);
    expect(meBody.memberships[0]?.organizationId).not.toBe(admin.organizationId);
  });
});

describe("Connect token carries iss claim", () => {
  const getApp = useTestApp();

  it("POST /me/connect-tokens stamps an iss derived from request host", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/connect-tokens",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; command: string }>();

    // Decode the JWT payload (not verifying signature — it's our own key)
    const parts = body.token.split(".");
    const payload = parts[1];
    if (!payload) throw new Error("expected JWT payload segment");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; type?: string };
    expect(decoded.type).toBe("connect");
    expect(decoded.iss).toMatch(/^https?:\/\//);

    expect(body.command).toBe(`first-tree-hub connect ${body.token}`);
  });
});

describe("/me wizard step inference", () => {
  const getApp = useTestApp();

  it("returns step=connect when no client/agent exists", async () => {
    const app = getApp();
    // Use a fresh OAuth user so we start clean — createTestAdmin pre-seeds
    // a client+agent which would push the wizard past the first step.
    const oauth = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=2001&login=fresh",
    });
    const fragment = oauth.headers.location?.split("#")[1] ?? "";
    const access = new URLSearchParams(fragment).get("access");
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.json<{ wizard: { step: string } }>().wizard.step).toBe("connect");
  });
});
