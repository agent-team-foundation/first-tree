import { afterAll, describe, expect, it } from "vitest";
import * as mappingService from "../services/adapter-mapping.js";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Adapter mapping service", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  describe("event deduplication", () => {
    it("claims an event the first time", async () => {
      const app = await appPromise;
      const claimed = await mappingService.claimEvent(app.db, "evt_unique_1", "feishu");
      expect(claimed).toBe(true);
    });

    it("rejects a duplicate event", async () => {
      const app = await appPromise;
      await mappingService.claimEvent(app.db, "evt_dup_1", "feishu");
      const duplicate = await mappingService.claimEvent(app.db, "evt_dup_1", "feishu");
      expect(duplicate).toBe(false);
    });

    it("allows same event_id on different platforms", async () => {
      const app = await appPromise;
      const r1 = await mappingService.claimEvent(app.db, "evt_cross_1", "feishu");
      const r2 = await mappingService.claimEvent(app.db, "evt_cross_1", "slack");
      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });
  });

  describe("agent mapping", () => {
    it("creates and finds agent mapping", async () => {
      const app = await appPromise;
      const { agent } = await createTestAgent(app, { id: "mapping-test-agent" });

      await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_mapping_user_1",
        agentId: agent.id,
        boundVia: "manual",
      });

      const found = await mappingService.findAgentByExternalUser(app.db, "feishu", "ou_mapping_user_1");
      expect(found).not.toBeNull();
      expect(found?.agentId).toBe(agent.id);
    });

    it("returns null for unmapped user", async () => {
      const app = await appPromise;
      const found = await mappingService.findAgentByExternalUser(app.db, "feishu", "ou_nonexistent");
      expect(found).toBeNull();
    });

    it("finds external user by agent", async () => {
      const app = await appPromise;
      const { agent } = await createTestAgent(app, { id: "reverse-mapping-agent" });

      await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_reverse_1",
        agentId: agent.id,
      });

      const found = await mappingService.findExternalUserByAgent(app.db, "feishu", agent.id);
      expect(found).not.toBeNull();
      expect(found?.externalUserId).toBe("ou_reverse_1");
    });

    it("handles duplicate mapping gracefully", async () => {
      const app = await appPromise;
      const { agent } = await createTestAgent(app, { id: "dup-mapping-agent" });

      const r1 = await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_dup_user",
        agentId: agent.id,
      });
      const r2 = await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_dup_user",
        agentId: agent.id,
      });
      expect(r1.agentId).toBe(r2.agentId);
    });
  });

  describe("chat mapping", () => {
    it("creates chat for new external channel", async () => {
      const app = await appPromise;
      const { agent: botAgent } = await createTestAgent(app, { id: "chat-map-bot-agent" });
      const { agent: sender } = await createTestAgent(app, { id: "chat-map-sender" });

      const chatId = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_new_channel_1",
        chatType: "group",
        botAgentId: botAgent.id,
        senderAgentId: sender.id,
      });

      expect(chatId).toBeTruthy();

      // Second call should return same chatId
      const chatId2 = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_new_channel_1",
        chatType: "group",
        botAgentId: botAgent.id,
        senderAgentId: sender.id,
      });
      expect(chatId2).toBe(chatId);
    });

    it("creates separate chats for different external channels", async () => {
      const app = await appPromise;
      const { agent: botAgent } = await createTestAgent(app, { id: "multi-ch-bot-agent" });
      const { agent: sender } = await createTestAgent(app, { id: "multi-ch-sender" });

      const chatId1 = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_multi_1",
        chatType: "group",
        botAgentId: botAgent.id,
        senderAgentId: sender.id,
      });

      const chatId2 = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_multi_2",
        chatType: "p2p",
        botAgentId: botAgent.id,
        senderAgentId: sender.id,
      });

      expect(chatId1).not.toBe(chatId2);
    });

    it("finds external channel by chat", async () => {
      const app = await appPromise;
      const { agent: botAgent } = await createTestAgent(app, { id: "reverse-ch-bot-agent" });
      const { agent: sender } = await createTestAgent(app, { id: "reverse-ch-sender" });

      const chatId = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_reverse_1",
        chatType: "group",
        botAgentId: botAgent.id,
        senderAgentId: sender.id,
      });

      const found = await mappingService.findExternalChannelByChat(app.db, "feishu", chatId);
      expect(found).not.toBeNull();
      expect(found?.externalChannelId).toBe("oc_reverse_1");
    });

    it("handles same agent as both bot and sender (p2p self-chat)", async () => {
      const app = await appPromise;
      const { agent } = await createTestAgent(app, { id: "self-chat-agent" });

      const chatId = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_self_chat",
        chatType: "p2p",
        botAgentId: agent.id,
        senderAgentId: agent.id,
      });

      expect(chatId).toBeTruthy();
    });
  });

  describe("message references", () => {
    it("creates and finds message reference", async () => {
      const app = await appPromise;
      // First create a real message for FK constraint
      const { agent } = await createTestAgent(app, { id: "msg-ref-agent" });
      const { createChat } = await import("../services/chat.js");
      const { sendMessage } = await import("../services/message.js");

      const chat = await createChat(app.db, agent.id, {
        type: "direct",
        participantIds: [agent.id],
      });
      const msg = await sendMessage(app.db, chat.id, agent.id, {
        format: "text",
        content: "test message for ref",
      });

      await mappingService.createMessageReference(app.db, {
        messageId: msg.id,
        platform: "feishu",
        externalMessageId: "om_ext_123",
        externalChannelId: "oc_ext_456",
      });

      const byExternal = await mappingService.findMessageByExternalId(app.db, "feishu", "om_ext_123");
      expect(byExternal?.messageId).toBe(msg.id);

      const byInternal = await mappingService.findExternalMessageByInternalId(app.db, "feishu", msg.id);
      expect(byInternal?.externalMessageId).toBe("om_ext_123");
    });

    it("returns null for unmapped messages", async () => {
      const app = await appPromise;
      const result = await mappingService.findMessageByExternalId(app.db, "feishu", "om_nonexistent");
      expect(result).toBeNull();
    });
  });
});
