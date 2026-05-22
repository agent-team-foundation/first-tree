import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedClient, useTestApp } from "./helpers.js";

/**
 * Attach `userId` to a freshly-created org with the requested role, mirroring
 * the helper that lives in admin-agents.test.ts. Each call returns a brand-
 * new org, the inserted member id, and the human agent provisioned for the
 * user in that org (so `scope.humanAgentId` is satisfied for routes that
 * resolve membership via `requireOrgMembership`).
 */
async function attachOrg(
  app: FastifyInstance,
  userId: string,
  role: "admin" | "member",
): Promise<{ orgId: string; memberId: string; humanAgentId: string }> {
  const orgId = `org-mm-${crypto.randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  let humanAgentId = "";
  await app.db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: orgId, name: `mm-${crypto.randomUUID().slice(0, 6)}`, displayName: "Multi-Org Side" });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `mm-h-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Multi-Org Human",
      managerId: memberId,
      organizationId: orgId,
    });
    humanAgentId = human.uuid;
    await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
  });
  return { orgId, memberId, humanAgentId };
}

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
    const body = res.json<{
      token: string;
      command: string;
      bootstrapCommand: string;
      npmSpec: string;
    }>();

    // Decode the JWT payload (not verifying signature — it's our own key)
    const parts = body.token.split(".");
    const payload = parts[1];
    if (!payload) throw new Error("expected JWT payload segment");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; type?: string };
    expect(decoded.type).toBe("connect");
    expect(decoded.iss).toMatch(/^https?:\/\//);

    expect(body.command).toBe(`first-tree-hub login ${body.token}`);
    // `bootstrapCommand` combines the channel-resolved `npm install -g` line
    // with the login command, so web onboarding renders a single copy-paste
    // block that lands the user on the version this Hub actually advertises.
    // Default test config runs channel=latest, so the npm spec stays bare.
    expect(body.npmSpec).toBe("@agent-team-foundation/first-tree-hub");
    expect(body.bootstrapCommand).toBe(`npm install -g ${body.npmSpec}\n${body.command}`);
  });
});

describe("/me onboarding step inference", () => {
  const getApp = useTestApp();

  it("returns step=connect when no client/agent exists", async () => {
    const app = getApp();
    // Use a fresh OAuth user so we start clean — createTestAdmin pre-seeds
    // a client+agent which would push onboarding past the first step.
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
    expect(me.json<{ onboarding: { step: string } }>().onboarding.step).toBe("connect");
  });

  /**
   * Regression for #239: the onboarding inference used to key off the JWT's
   * default `memberId`, so a user whose only autonomous agent lived in a
   * non-default org would still see `step=create_agent` even though the
   * onboarding was actually complete. Post JWT-scope-strip, both `clients`
   * and `agents` lookups are user-scoped (clients.user_id, members.user_id)
   * — the regression is structurally impossible because `request.user` no
   * longer carries `memberId`. This test pins that contract at the HTTP
   * boundary so a future "optimization" that re-introduces a member-keyed
   * shortcut fails CI.
   */
  it("returns step=completed when the only autonomous agent lives in a non-default org (regression #239)", async () => {
    const app = getApp();
    // createTestAdmin gives Alice a default org with only her human-self
    // agent + admin membership — onboarding should currently report `connect`
    // (no client) for that user.
    const alice = await createTestAdmin(app);

    // Spin up a side org Alice belongs to as a member, hang a client +
    // autonomous agent off her membership in that org. Crucially the agent
    // is NOT in the default org returned by createTestAdmin.
    const orgB = await attachOrg(app, alice.userId, "member");
    const clientId = await seedClient(app, alice.userId, orgB.orgId);
    await createAgent(app.db, {
      name: `regression-239-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Regression #239",
      managerId: orgB.memberId,
      organizationId: orgB.orgId,
      clientId,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ onboarding: { step: string } }>().onboarding.step).toBe("completed");
  });
});
