import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createChat } from "../services/chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

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
    const peer = await createTestAgent(app, { type: "autonomous_agent", displayName: "Peer Bot" });
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

  it("agent GET /agent/chats/:chatId returns avatarColorToken + avatarImageUrl", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "autonomous_agent", displayName: "Caller Bot" });
    const peer = await createTestAgent(app, { type: "autonomous_agent", displayName: "Peer Bot" });
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

  it("agent GET /agent/chats/:chatId/participants returns avatarColorToken + avatarImageUrl", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "autonomous_agent", displayName: "Caller Bot" });
    const peer = await createTestAgent(app, { type: "autonomous_agent", displayName: "Peer Bot" });
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
});
