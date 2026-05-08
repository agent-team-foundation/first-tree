import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, useTestApp } from "./helpers.js";

describe("GET /api/v1/me", () => {
  const getApp = useTestApp();

  it("returns current user, member, and agent info", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      user: { id: string; username: string; displayName: string };
      member: { id: string; organizationId: string; role: string; agentId: string };
      agent: { uuid: string; name: string; inboxId: string };
    }>();

    expect(body.user).toBeDefined();
    expect(body.user.username).toBe(admin.username);
    expect(body.member).toBeDefined();
    expect(body.member.role).toBe("admin");
    expect(body.member.agentId).toBeDefined();
    expect(body.agent).toBeDefined();
    expect(body.agent.uuid).toBe(body.member.agentId);
  });

  it("rejects unauthenticated request", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * `wizardStep` is user-level: once the operator has connected any client
   * AND created any non-human agent in any of their memberships, the
   * wizard is `completed` everywhere. Earlier code keyed the agent check
   * off `m.memberId` (JWT default org), which froze multi-org users in
   * `create_agent` whenever their work happened in a non-default team —
   * the workspace then re-popped OnboardingView in every team they
   * switched into, even ones with existing agents.
   */
  describe("wizardStep is user-level (multi-org)", () => {
    it("returns `completed` when the user's only managed agent lives in a non-default org", async () => {
      const app = getApp();
      const alice = await createAdminContext(app);

      // Stand up a second org Alice is admin of, and seed her managed
      // agent there. Her JWT default org keeps zero non-human agents.
      const orgBId = `org-wizard-${crypto.randomUUID().slice(0, 8)}`;
      const orgBMemberId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx
          .insert(organizations)
          .values({ id: orgBId, name: `wizard-${crypto.randomUUID().slice(0, 6)}`, displayName: "Wizard Side" });
        const human = await createAgent(tx as unknown as typeof app.db, {
          name: `wizard-h-${crypto.randomUUID().slice(0, 6)}`,
          type: "human",
          displayName: "Wizard Human",
          managerId: orgBMemberId,
          organizationId: orgBId,
        });
        await tx.insert(members).values({
          id: orgBMemberId,
          userId: alice.userId,
          organizationId: orgBId,
          agentId: human.uuid,
          role: "admin",
        });
      });

      // Non-human agent ONLY in org B; managerId points at Alice's org-B
      // member, not her JWT-default member.
      await createAgent(app.db, {
        name: `wizard-target-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Wizard Target",
        managerId: orgBMemberId,
        clientId: alice.clientId,
        organizationId: orgBId,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${alice.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ wizard: { step: string } }>();
      expect(body.wizard.step).toBe("completed");
    });

    it("still returns `create_agent` when the user has a client but no managed agents anywhere", async () => {
      const app = getApp();
      const alice = await createAdminContext(app);
      // createAdminContext seeds a client but no non-human agent — the
      // legacy "create_agent" branch should still fire.
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${alice.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ wizard: { step: string } }>();
      expect(body.wizard.step).toBe("create_agent");
    });

    it("still returns `connect` when the user has no clients", async () => {
      const app = getApp();
      // createTestAdmin (vs createAdminContext) does NOT seed a client.
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ wizard: { step: string } }>();
      expect(body.wizard.step).toBe("connect");
    });
  });
});
