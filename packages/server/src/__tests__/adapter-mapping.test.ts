import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { processedEvents } from "../db/schema/processed-events.js";
import * as mappingService from "../services/adapter-mapping.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Adapter mapping service", () => {
  const getApp = useTestApp();

  describe("event deduplication", () => {
    it("claims an event the first time", async () => {
      const app = getApp();
      const claimed = await mappingService.claimEvent(app.db, "evt_unique_1", "feishu");
      expect(claimed).toBe(true);
    });

    it("rejects a duplicate event", async () => {
      const app = getApp();
      await mappingService.claimEvent(app.db, "evt_dup_1", "feishu");
      const duplicate = await mappingService.claimEvent(app.db, "evt_dup_1", "feishu");
      expect(duplicate).toBe(false);
    });

    it("allows same event_id on different platforms", async () => {
      const app = getApp();
      const r1 = await mappingService.claimEvent(app.db, "evt_cross_1", "feishu");
      const r2 = await mappingService.claimEvent(app.db, "evt_cross_1", "slack");
      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    // M3 (#509): the dedup ledger must not grow unboundedly. Rows older
    // than the retention window are deleted so the table stays bounded
    // and the `INSERT ... ON CONFLICT` unique-index lookup at every
    // claim doesn't degrade as load scales.
    it("pruneProcessedEvents deletes rows older than the retention window and keeps fresh ones", async () => {
      const app = getApp();

      // Seed three rows: one fresh, one borderline (just inside the
      // window), one stale (older than the window).
      await mappingService.claimEvent(app.db, "evt_fresh", "feishu");
      await mappingService.claimEvent(app.db, "evt_borderline", "feishu");
      await mappingService.claimEvent(app.db, "evt_stale", "feishu");

      // Force the stale row's `created_at` back by 60 days; the
      // borderline row stays under the 30-day window we'll prune with.
      await app.db.execute(
        sql`UPDATE processed_events SET created_at = NOW() - interval '60 days' WHERE event_id = 'evt_stale'`,
      );

      const result = await mappingService.pruneProcessedEvents(app.db, 30 * 24 * 60 * 60);
      expect(result.deleted).toBe(1);

      const remaining = await app.db.select({ eventId: processedEvents.eventId }).from(processedEvents);
      const ids = remaining.map((r) => r.eventId).sort();
      expect(ids).toEqual(["evt_borderline", "evt_fresh"]);
    });
  });

  describe("agent mapping", () => {
    it("creates and finds agent mapping", async () => {
      const app = getApp();
      const { agent } = await createTestAgent(app, { name: "mapping-test-agent" });

      await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_mapping_user_1",
        agentId: agent.uuid,
        boundVia: "manual",
      });

      const found = await mappingService.findAgentByExternalUser(app.db, "feishu", "ou_mapping_user_1");
      expect(found).not.toBeNull();
      expect(found?.agentId).toBe(agent.uuid);
    });

    it("returns null for unmapped user", async () => {
      const app = getApp();
      const found = await mappingService.findAgentByExternalUser(app.db, "feishu", "ou_nonexistent");
      expect(found).toBeNull();
    });

    it("finds external user by agent", async () => {
      const app = getApp();
      const { agent } = await createTestAgent(app, { name: "reverse-mapping-agent" });

      await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_reverse_1",
        agentId: agent.uuid,
      });

      const found = await mappingService.findExternalUserByAgent(app.db, "feishu", agent.uuid);
      expect(found).not.toBeNull();
      expect(found?.externalUserId).toBe("ou_reverse_1");
    });

    it("handles duplicate mapping gracefully", async () => {
      const app = getApp();
      const { agent } = await createTestAgent(app, { name: "dup-mapping-agent" });

      const r1 = await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_dup_user",
        agentId: agent.uuid,
      });
      const r2 = await mappingService.createAgentMapping(app.db, {
        platform: "feishu",
        externalUserId: "ou_dup_user",
        agentId: agent.uuid,
      });
      expect(r1.agentId).toBe(r2.agentId);
    });
  });

  describe("chat mapping", () => {
    it("creates chat for new external channel", async () => {
      const app = getApp();
      const { agent: botAgent } = await createTestAgent(app, { name: "chat-map-bot-agent" });
      const { agent: sender } = await createTestAgent(app, { name: "chat-map-sender" });

      const chatId = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_new_channel_1",
        chatType: "group",
        botAgentId: botAgent.uuid,
        senderAgentId: sender.uuid,
      });

      expect(chatId).toBeTruthy();

      // Second call should return same chatId
      const chatId2 = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_new_channel_1",
        chatType: "group",
        botAgentId: botAgent.uuid,
        senderAgentId: sender.uuid,
      });
      expect(chatId2).toBe(chatId);
    });

    it("creates separate chats for different external channels", async () => {
      const app = getApp();
      const { agent: botAgent } = await createTestAgent(app, { name: "multi-ch-bot-agent" });
      const { agent: sender } = await createTestAgent(app, { name: "multi-ch-sender" });

      const chatId1 = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_multi_1",
        chatType: "group",
        botAgentId: botAgent.uuid,
        senderAgentId: sender.uuid,
      });

      const chatId2 = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_multi_2",
        chatType: "p2p",
        botAgentId: botAgent.uuid,
        senderAgentId: sender.uuid,
      });

      expect(chatId1).not.toBe(chatId2);
    });

    it("finds external channel by chat", async () => {
      const app = getApp();
      const { agent: botAgent } = await createTestAgent(app, { name: "reverse-ch-bot-agent" });
      const { agent: sender } = await createTestAgent(app, { name: "reverse-ch-sender" });

      const chatId = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_reverse_1",
        chatType: "group",
        botAgentId: botAgent.uuid,
        senderAgentId: sender.uuid,
      });

      const found = await mappingService.findExternalChannelByChat(app.db, "feishu", chatId);
      expect(found).not.toBeNull();
      expect(found?.externalChannelId).toBe("oc_reverse_1");
    });

    it("handles same agent as both bot and sender (p2p self-chat)", async () => {
      const app = getApp();
      const { agent } = await createTestAgent(app, { name: "self-chat-agent" });

      const chatId = await mappingService.findOrCreateChatForChannel(app.db, {
        platform: "feishu",
        externalChannelId: "oc_self_chat",
        chatType: "p2p",
        botAgentId: agent.uuid,
        senderAgentId: agent.uuid,
      });

      expect(chatId).toBeTruthy();
    });
  });

  describe("message references", () => {
    it("creates and finds message reference", async () => {
      const app = getApp();
      // First create a real message for FK constraint
      const { agent } = await createTestAgent(app, { name: "msg-ref-agent" });
      const { createChat } = await import("../services/chat.js");
      const { sendMessage } = await import("../services/message.js");

      const chat = await createChat(app.db, agent.uuid, {
        type: "group",
        participantIds: [agent.uuid],
      });
      const { message: msg } = await sendMessage(app.db, chat.id, agent.uuid, {
        source: "api",
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
      const app = getApp();
      const result = await mappingService.findMessageByExternalId(app.db, "feishu", "om_nonexistent");
      expect(result).toBeNull();
    });
  });
});
