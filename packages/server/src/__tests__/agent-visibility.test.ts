import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Helper: create an admin user + return a request function bound to their JWT.
 */
async function authedRequest(app: FastifyInstance, username?: string) {
  const admin = await createTestAdmin(app, {
    username: username ?? `vis-admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  return {
    req: (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      }),
    admin,
  };
}

/**
 * Helper: create a regular member (non-admin) and return a request function.
 */
async function createMemberAndLogin(
  app: FastifyInstance,
  adminReq: ReturnType<typeof authedRequest> extends Promise<infer T> ? T : never,
) {
  const username = `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const createRes = await adminReq.req("POST", "/api/v1/members", {
    username,
    displayName: "Test Member",
    role: "member",
  });
  const memberData = createRes.json<{ id: string; password: string; agentId: string }>();

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: memberData.password },
  });
  const { accessToken } = loginRes.json<{ accessToken: string }>();

  return {
    memberId: memberData.id,
    agentId: memberData.agentId,
    accessToken,
    req: (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${accessToken}` },
        ...(payload ? { payload } : {}),
      }),
  };
}

describe("Agent Visibility", () => {
  const getApp = useTestApp();

  describe("default visibility by type", () => {
    it("human agents default to organization visibility", async () => {
      const app = getApp();
      const agent = await createAgent(app.db, { name: "vis-human", type: "human" });
      expect(agent.visibility).toBe("organization");
    });

    it("autonomous_agent defaults to organization visibility", async () => {
      const app = getApp();
      const agent = await createAgent(app.db, { name: "vis-auto", type: "autonomous_agent" });
      expect(agent.visibility).toBe("organization");
    });

    it("personal_assistant defaults to private visibility", async () => {
      const app = getApp();
      const agent = await createAgent(app.db, { name: "vis-pa", type: "personal_assistant" });
      expect(agent.visibility).toBe("private");
    });

    it("explicit visibility overrides default", async () => {
      const app = getApp();
      const agent = await createAgent(app.db, {
        name: "vis-override",
        type: "personal_assistant",
        visibility: "organization",
      });
      expect(agent.visibility).toBe("organization");
    });
  });

  describe("visibility filtering in agent listing", () => {
    it("admin sees organization-visible agents and their own private agents (same as member)", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);

      // Get admin's memberId from /me
      const meRes = await adminReq("GET", "/api/v1/me");
      const adminMemberId = meRes.json<{ member: { id: string } }>().member.id;

      // Create agents: org-visible, admin's private, unowned private
      await createAgent(app.db, { name: "admin-see-org", type: "autonomous_agent" });
      await createAgent(app.db, { name: "admin-see-own-priv", type: "personal_assistant", managerId: adminMemberId });
      await createAgent(app.db, { name: "admin-hidden-priv", type: "personal_assistant" });

      const res = await adminReq("GET", "/api/v1/admin/agents?limit=100");
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ name: string; visibility: string }> }>();
      const names = body.items.map((a) => a.name);
      expect(names).toContain("admin-see-org");
      expect(names).toContain("admin-see-own-priv");
      expect(names).not.toContain("admin-hidden-priv");
    });

    it("member sees organization-visible agents and their own private agents", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      // Create agents: one org-visible, one private managed by this member, one private managed by admin
      await createAgent(app.db, { name: "member-see-org", type: "autonomous_agent" });
      await createAgent(app.db, {
        name: "member-see-my",
        type: "personal_assistant",
        managerId: member.memberId,
      });
      await createAgent(app.db, {
        name: "member-hidden",
        type: "personal_assistant",
      });

      const res = await member.req("GET", "/api/v1/admin/agents?limit=100");
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ name: string; visibility: string }> }>();
      const names = body.items.map((a) => a.name);

      expect(names).toContain("member-see-org");
      expect(names).toContain("member-see-my");
      expect(names).not.toContain("member-hidden");
    });
  });

  describe("visibility in single agent GET", () => {
    it("member cannot access private agent managed by another member", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const privateAgent = await createAgent(app.db, {
        name: "no-access-priv",
        type: "personal_assistant",
      });

      const res = await member.req("GET", `/api/v1/admin/agents/${privateAgent.uuid}`);
      expect(res.statusCode).toBe(404);
    });

    it("member can access organization-visible agent", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const orgAgent = await createAgent(app.db, { name: "access-org", type: "autonomous_agent" });

      const res = await member.req("GET", `/api/v1/admin/agents/${orgAgent.uuid}`);
      expect(res.statusCode).toBe(200);
    });

    it("member can access their own private agent", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const myAgent = await createAgent(app.db, {
        name: "access-my-priv",
        type: "personal_assistant",
        managerId: member.memberId,
      });

      const res = await member.req("GET", `/api/v1/admin/agents/${myAgent.uuid}`);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("managerId authorization for PATCH", () => {
    it("member can update their own agent", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const myAgent = await createAgent(app.db, {
        name: "patch-my",
        type: "personal_assistant",
        managerId: member.memberId,
      });

      const res = await member.req("PATCH", `/api/v1/admin/agents/${myAgent.uuid}`, {
        displayName: "Updated",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().displayName).toBe("Updated");
    });

    it("member cannot update another member's agent", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const otherAgent = await createAgent(app.db, {
        name: "patch-other",
        type: "autonomous_agent",
      });

      const res = await member.req("PATCH", `/api/v1/admin/agents/${otherAgent.uuid}`, {
        displayName: "Hacked",
      });
      expect(res.statusCode).toBe(404);
    });

    it("admin can update any agent", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);

      const agent = await createAgent(app.db, {
        name: "patch-admin",
        type: "autonomous_agent",
      });

      const res = await adminReq("PATCH", `/api/v1/admin/agents/${agent.uuid}`, {
        displayName: "Admin Updated",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().displayName).toBe("Admin Updated");
    });
  });

  describe("visibility update via PATCH", () => {
    it("can change visibility from private to organization", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);

      const agent = await createAgent(app.db, { name: "vis-change", type: "personal_assistant" });
      expect(agent.visibility).toBe("private");

      const res = await adminReq("PATCH", `/api/v1/admin/agents/${agent.uuid}`, {
        visibility: "organization",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().visibility).toBe("organization");
    });
  });
});

describe("Chat Access Control", () => {
  const getApp = useTestApp();

  describe("GET /admin/chats/mine — member-scoped grouped listing", () => {
    it("returns chats grouped by agent for the member", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      // Create a personal assistant managed by member
      const assistant = await createAgent(app.db, {
        name: "chat-pa",
        type: "personal_assistant",
        managerId: member.memberId,
      });

      // Create a chat between member's human agent and assistant
      await createChat(app.db, member.agentId, {
        type: "direct",
        participantIds: [assistant.uuid],
      });

      const res = await member.req("GET", "/api/v1/admin/chats/mine");
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ agent: { uuid: string }; chats: Array<{ id: string }> }>>();

      // Should have at least one agent group with chats
      expect(body.length).toBeGreaterThanOrEqual(1);
      const agentUuids = body.map((g) => g.agent.uuid);
      // Should include the member's human agent or the assistant
      expect(agentUuids.some((id) => id === member.agentId || id === assistant.uuid)).toBe(true);
    });

    it("does not return chats from other members' agents", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, admin);
      const memberB = await createMemberAndLogin(app, admin);

      // Create agents for A and B
      const assistantA = await createAgent(app.db, {
        name: "chat-a-pa",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });
      const assistantB = await createAgent(app.db, {
        name: "chat-b-pa",
        type: "personal_assistant",
        managerId: memberB.memberId,
      });

      // Create a chat for A
      const chatA = await createChat(app.db, memberA.agentId, {
        type: "direct",
        participantIds: [assistantA.uuid],
      });

      // Create a chat for B
      await createChat(app.db, memberB.agentId, {
        type: "direct",
        participantIds: [assistantB.uuid],
      });

      // B should NOT see A's chat
      const res = await memberB.req("GET", "/api/v1/admin/chats/mine");
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ agent: { uuid: string }; chats: Array<{ id: string }> }>>();
      const allChatIds = body.flatMap((g) => g.chats.map((c) => c.id));
      expect(allChatIds).not.toContain(chatA.id);
    });
  });

  describe("POST /admin/chats/:chatId/join — manager joins chat", () => {
    it("manager can join a chat of their managed agent", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      // Create two agents managed by member
      const agentA = await createAgent(app.db, {
        name: "join-a",
        type: "personal_assistant",
        managerId: member.memberId,
      });
      const agentB = await createAgent(app.db, {
        name: "join-b",
        type: "personal_assistant",
        managerId: member.memberId,
      });

      // Create a chat between the two agents (not including human agent)
      const chat = await createChat(app.db, agentA.uuid, {
        type: "direct",
        participantIds: [agentB.uuid],
      });

      // Member joins the chat
      const res = await member.req("POST", `/api/v1/admin/chats/${chat.id}/join`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ participants: Array<{ agentId: string }> }>();
      const participantIds = body.participants.map((p) => p.agentId);
      expect(participantIds).toContain(member.agentId);
    });

    it("member cannot join a chat they don't supervise", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, admin);
      const memberB = await createMemberAndLogin(app, admin);

      // Create agents managed by member A
      const agentA = await createAgent(app.db, {
        name: "nojoin-a",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });
      const agentA2 = await createAgent(app.db, {
        name: "nojoin-a2",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });

      // Create a chat between A's agents
      const chat = await createChat(app.db, agentA.uuid, {
        type: "direct",
        participantIds: [agentA2.uuid],
      });

      // Member B tries to join — should fail (403 from joinChat supervision check)
      const res = await memberB.req("POST", `/api/v1/admin/chats/${chat.id}/join`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /admin/chats/:chatId/leave — manager leaves chat", () => {
    it("manager can leave a chat they joined", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const assistant = await createAgent(app.db, {
        name: "leave-pa",
        type: "personal_assistant",
        managerId: member.memberId,
      });

      // Create chat with human agent as participant
      const chat = await createChat(app.db, member.agentId, {
        type: "direct",
        participantIds: [assistant.uuid],
      });

      // Member leaves
      const res = await member.req("POST", `/api/v1/admin/chats/${chat.id}/leave`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ participants: Array<{ agentId: string }> }>();
      const participantIds = body.participants.map((p) => p.agentId);
      expect(participantIds).not.toContain(member.agentId);
    });

    it("returns 404 if not a participant", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, admin);
      const memberB = await createMemberAndLogin(app, admin);

      const assistant = await createAgent(app.db, {
        name: "leave-other-pa",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "direct",
        participantIds: [assistant.uuid],
      });

      // B is not a participant — leave should fail
      const res = await memberB.req("POST", `/api/v1/admin/chats/${chat.id}/leave`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /:chatId — access control", () => {
    it("non-participant member cannot read chat detail", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, admin);
      const memberB = await createMemberAndLogin(app, admin);

      const assistant = await createAgent(app.db, {
        name: "detail-pa",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "direct",
        participantIds: [assistant.uuid],
      });

      const res = await memberB.req("GET", `/api/v1/admin/chats/${chat.id}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /:chatId/messages — access control", () => {
    it("non-participant member cannot read messages", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, admin);
      const memberB = await createMemberAndLogin(app, admin);

      const assistant = await createAgent(app.db, {
        name: "msg-pa",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "direct",
        participantIds: [assistant.uuid],
      });

      const res = await memberB.req("GET", `/api/v1/admin/chats/${chat.id}/messages`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /:chatId/messages — access control", () => {
    it("non-participant member cannot send messages", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, admin);
      const memberB = await createMemberAndLogin(app, admin);

      const assistant = await createAgent(app.db, {
        name: "send-pa",
        type: "personal_assistant",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "direct",
        participantIds: [assistant.uuid],
      });

      const res = await memberB.req("POST", `/api/v1/admin/chats/${chat.id}/messages`, {
        format: "text",
        content: "should fail",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /:uuid — managerId authorization", () => {
    it("non-manager member cannot delete agent", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const agent = await createAgent(app.db, {
        name: "del-other",
        type: "autonomous_agent",
      });

      // Suspend first (required before delete)
      await admin.req("POST", `/api/v1/admin/agents/${agent.uuid}/suspend`);

      const res = await member.req("DELETE", `/api/v1/admin/agents/${agent.uuid}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /admin/chats — admin-only", () => {
    it("non-admin member cannot list all chats", async () => {
      const app = getApp();
      const admin = await authedRequest(app);
      const member = await createMemberAndLogin(app, admin);

      const res = await member.req("GET", "/api/v1/admin/chats");
      expect(res.statusCode).toBe(403);
    });

    it("admin can list all chats", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);

      const res = await adminReq("GET", "/api/v1/admin/chats");
      expect(res.statusCode).toBe(200);
    });
  });
});
