import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { configuredAvatarAuthorityTag } from "../utils/server-authority.js";
import { createAdminContext, createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Regression: the chat-detail surface used to drop the manager-configured
 * `avatarColorToken` / `avatarImageUrl` from the wire shape of every
 * `/chats/:chatId` route (admin and agent), even though the SELECT pulled
 * them out of the agents JOIN. The web client (header chips + right-sidebar
 * agent rows) then fell back to the deterministic djb2-hash hue, so a hue
 * the manager set in Appearance never showed on those surfaces.
 *
 * Pin: every chat-participant payload exposes both fields, mirroring
 * `meChatParticipantSchema` so the chat-detail and left-rail renders agree.
 */
describe("chat-detail wire shape — participant avatar fields", () => {
  const getApp = useTestApp();

  it("admin GET /chats/:chatId returns avatarColorToken + avatarImageUrl for every participant", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Peer Bot" });
    await app.db.update(agents).set({ avatarColorToken: "hue-3" }).where(eq(agents.uuid, peer.agent.uuid));

    const chat = await createChat(app.db, caller.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      participants: Array<{
        agentId: string;
        avatarColorToken: string | null;
        avatarImageUrl: string | null;
      }>;
    };
    const peerRow = body.participants.find((p) => p.agentId === peer.agent.uuid);
    expect(peerRow).toBeDefined();
    expect(peerRow?.avatarColorToken).toBe("hue-3");
    // No image uploaded — synthesizer returns null.
    expect(peerRow?.avatarImageUrl).toBeNull();
    const callerRow = body.participants.find((p) => p.agentId === caller.agent.uuid);
    expect(callerRow?.avatarColorToken).toBeNull();
  });

  it("admin GET /chats/:chatId falls back to a human user's external avatar", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app);
    const teammate = await createTestAdmin(app);
    const teammateAvatar = "https://avatars.githubusercontent.com/u/24680?v=4";
    await app.db.update(users).set({ avatarUrl: teammateAvatar }).where(eq(users.id, teammate.userId));

    const chat = await createChat(app.db, caller.humanAgentUuid, {
      type: "group",
      participantIds: [teammate.humanAgentUuid],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      participants: Array<{
        agentId: string;
        avatarImageUrl: string | null;
      }>;
    };

    expect(body.participants.find((p) => p.agentId === teammate.humanAgentUuid)?.avatarImageUrl).toBe(teammateAvatar);
  });

  it("admin GET /chats/:chatId prefers uploaded human avatars over external avatars", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app);
    const teammate = await createTestAdmin(app);
    const uploadedAt = new Date("2026-06-15T12:00:00.000Z");
    await app.db
      .update(users)
      .set({ avatarUrl: "https://avatars.githubusercontent.com/u/13579?v=4" })
      .where(eq(users.id, teammate.userId));
    await app.db
      .update(agents)
      .set({
        avatarImageData: Buffer.from("avatar"),
        avatarImageMime: "image/webp",
        avatarImageUpdatedAt: uploadedAt,
      })
      .where(eq(agents.uuid, teammate.humanAgentUuid));

    const chat = await createChat(app.db, caller.humanAgentUuid, {
      type: "group",
      participantIds: [teammate.humanAgentUuid],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      participants: Array<{
        agentId: string;
        avatarImageUrl: string | null;
      }>;
    };

    expect(body.participants.find((p) => p.agentId === teammate.humanAgentUuid)?.avatarImageUrl).toBe(
      `/api/v1/agents/${teammate.humanAgentUuid}/avatar?v=${uploadedAt.getTime()}&ft_authority=${configuredAvatarAuthorityTag(app.config)}`,
    );
  });

  it("admin GET /chats/:chatId returns active/null caller state for supervisor access without direct membership", async () => {
    const app = getApp();
    const supervisor = await createAdminContext(app);
    const owner = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `detail-managed-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Managed Detail Bot",
      managerId: supervisor.memberId,
      organizationId: supervisor.organizationId,
      clientId: supervisor.clientId,
    });

    const chat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [managed.uuid],
    });
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, supervisor.humanAgentUuid)));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${supervisor.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      engagementStatus: string;
      viewerMembershipKind: string | null;
    };
    expect(body.engagementStatus).toBe("active");
    expect(body.viewerMembershipKind).toBeNull();
  });

  it("agent GET /agent/chats/:chatId returns avatarColorToken + avatarImageUrl", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "agent", displayName: "Caller Bot" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Peer Bot" });
    await app.db.update(agents).set({ avatarColorToken: "hue-5" }).where(eq(agents.uuid, peer.agent.uuid));

    const chatRes = await caller.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await caller.request("GET", `/api/v1/agent/chats/${chatId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      participants: Array<{
        agentId: string;
        avatarColorToken: string | null;
        avatarImageUrl: string | null;
      }>;
    };
    const peerRow = body.participants.find((p) => p.agentId === peer.agent.uuid);
    expect(peerRow?.avatarColorToken).toBe("hue-5");
    expect(peerRow?.avatarImageUrl).toBeNull();
  });

  it("agent GET /agent/chats/:chatId falls back to a human user's external avatar", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller Human" });
    const teammate = await createTestAdmin(app);
    const teammateAvatar = "https://avatars.githubusercontent.com/u/97531?v=4";
    await app.db.update(users).set({ avatarUrl: teammateAvatar }).where(eq(users.id, teammate.userId));

    const chatRes = await caller.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [teammate.humanAgentUuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await caller.request("GET", `/api/v1/agent/chats/${chatId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      participants: Array<{
        agentId: string;
        avatarImageUrl: string | null;
      }>;
    };

    expect(body.participants.find((p) => p.agentId === teammate.humanAgentUuid)?.avatarImageUrl).toBe(teammateAvatar);
  });

  it("agent GET /agent/chats/:chatId/participants returns avatarColorToken + avatarImageUrl", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "agent", displayName: "Caller Bot" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Peer Bot" });
    await app.db.update(agents).set({ avatarColorToken: "hue-1" }).where(eq(agents.uuid, peer.agent.uuid));

    const chatRes = await caller.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await caller.request("GET", `/api/v1/agent/chats/${chatId}/participants`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      agentId: string;
      avatarColorToken: string | null;
      avatarImageUrl: string | null;
    }>;
    const peerRow = body.find((p) => p.agentId === peer.agent.uuid);
    expect(peerRow?.avatarColorToken).toBe("hue-1");
    expect(peerRow?.avatarImageUrl).toBeNull();
  });

  it("agent GET /agent/chats/:chatId/participants falls back to a human user's external avatar", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller Human" });
    const teammate = await createTestAdmin(app);
    const teammateAvatar = "https://avatars.githubusercontent.com/u/86420?v=4";
    await app.db.update(users).set({ avatarUrl: teammateAvatar }).where(eq(users.id, teammate.userId));

    const chatRes = await caller.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [teammate.humanAgentUuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await caller.request("GET", `/api/v1/agent/chats/${chatId}/participants`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      agentId: string;
      avatarImageUrl: string | null;
    }>;

    expect(body.find((p) => p.agentId === teammate.humanAgentUuid)?.avatarImageUrl).toBe(teammateAvatar);
  });
});
