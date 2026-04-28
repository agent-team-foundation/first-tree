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

  it("POST /me/organizations creates a new team and returns admin tokens for it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: `t-${crypto.randomUUID().slice(0, 8)}`, displayName: "Side Project" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      organization: { id: string; role: string };
      tokens: { accessToken: string };
    }>();
    expect(body.organization.role).toBe("admin");

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ member: { organizationId: string } }>().member.organizationId).toBe(body.organization.id);
  });

  it("POST /me/organizations/leave soft-deletes membership and invalidates tokens", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // Create a second team so leaving the first is meaningful (we'd otherwise
    // strand the user with zero teams, which is an explicit v1 trade-off
    // documented in the proposal).
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: `t-${crypto.randomUUID().slice(0, 8)}`, displayName: "Second" },
    });
    const secondTokens = second.json<{ tokens: { accessToken: string } }>().tokens;

    // Leave the first org via the original token.
    const leaveRes = await app.inject({
      method: "POST",
      url: "/api/v1/me/organizations/leave",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(leaveRes.statusCode).toBe(204);

    // Old token now refers to a "left" member → 401.
    const reuse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(reuse.statusCode).toBe(401);

    // Second-team token still works.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${secondTokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);

    // DB row is flipped to status='left'
    const rows = await app.db.select().from(members).where(eq(members.id, admin.memberId));
    expect(rows[0]?.status).toBe("left");
  });

  it("POST /auth/switch-org refuses orgs the user does not belong to", async () => {
    const app = getApp();
    const adminA = await createTestAdmin(app);
    // Spin up another user + org via OAuth dev-callback.
    const oauth = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=321&login=foreigner",
    });
    const fragment = oauth.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    const foreignerAccess = params.get("access");

    const foreignerMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${foreignerAccess}` },
    });
    const foreignerOrgId = foreignerMe.json<{ member: { organizationId: string } }>().member.organizationId;

    // adminA tries to switch into foreigner's org → 403
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-org",
      headers: { authorization: `Bearer ${adminA.accessToken}` },
      payload: { organizationId: foreignerOrgId },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Connect token carries iss claim", () => {
  const getApp = useTestApp();

  it("POST /connect-tokens stamps an iss derived from request host", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/connect-tokens",
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
