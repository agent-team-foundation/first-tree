import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Chat fan-out semantics post-retire of content extraction.
 *
 *   - `chat_membership.mode` is decision-inert; every freshly-written
 *     speaker row stores the constant `'mention_only'`.
 *   - `notify=true` is driven entirely by explicit signals —
 *     `addressedToAgentIds` or `metadata.mentions`. The previous "1:1
 *     implicit wake" rule was removed when the explicit-only contract
 *     took its place; web clients inject the peer's uuid on the wire
 *     in 2-speaker chats so wake-up still fires transparently.
 *   - `purpose: "agent-final-text"` still forces notify=false for every
 *     row.
 */
describe("chat membership + fan-out semantics (explicit-only)", () => {
  const getApp = useTestApp();

  async function loadModes(chatId: string) {
    const app = getApp();
    return app.db
      .select({ agentId: chatMembership.agentId, mode: chatMembership.mode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
  }

  async function notifyEntries(chatId: string, agentUuid: string) {
    const app = getApp();
    const [row] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, agentUuid))
      .limit(1);
    if (!row) return [];
    return app.db
      .select({ messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(
        and(eq(inboxEntries.inboxId, row.inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)),
      );
  }

  describe("addChatParticipants writes mode='mention_only' as a constant", () => {
    it("two agents (size=2 group) → both `mention_only`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `cc-aa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `cc-aa2-${uid}` });

      const chat = await createChat(app.db, a1.agent.uuid, {
        type: "group",
        participantIds: [a2.uuid],
      });
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["mention_only", "mention_only"]);
    });

    it("human + agent (size=2 group) → both `mention_only`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `cc-h-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `cc-a-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [agent.uuid],
      });
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["mention_only", "mention_only"]);
    });

    it("group with three+ speakers → every speaker row is `mention_only`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `cc-g1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `cc-g2-${uid}` });
      const { agent: a3 } = await createTestAgent(app, { name: `cc-g3-${uid}` });

      const chat = await createChat(app.db, a1.agent.uuid, {
        type: "group",
        participantIds: [a2.uuid, a3.uuid],
      });
      const modes = await loadModes(chat.id);
      expect(modes.every((m) => m.mode === "mention_only")).toBe(true);
    });
  });

  describe("explicit-only fan-out semantics (no more 1:1 implicit wake)", () => {
    it("1-on-1 without explicit mentions does NOT wake the peer (regression guard for the retired implicit wake)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-h-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `fo-ha-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [agent.uuid],
      });
      await sendMessage(
        app.db,
        chat.id,
        human.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "what's the date?",
        },
        { allowRecipientlessSend: true },
      );

      expect(await notifyEntries(chat.id, agent.uuid)).toHaveLength(0);
    });

    it("human→agent 1-on-1 with explicit mentions wakes the agent (web composer auto-inject pattern)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-hw-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `fo-haw-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [agent.uuid],
      });
      await sendMessage(app.db, chat.id, human.agent.uuid, {
        source: "web",
        format: "text",
        content: "what's the date?",
        metadata: { mentions: [agent.uuid] },
      });

      expect(await notifyEntries(chat.id, agent.uuid)).toHaveLength(1);
    });

    it("agent→human 1-on-1 with explicit mentions wakes the human (symmetric)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-h2-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `fo-ha2-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [agent.uuid],
      });
      await sendMessage(app.db, chat.id, agent.uuid, {
        source: "api",
        format: "text",
        content: "today is 2026-04-29",
        metadata: { mentions: [human.agent.uuid] },
      });

      expect(await notifyEntries(chat.id, human.agent.uuid)).toHaveLength(1);
    });

    it("agent→agent 1-on-1 with explicit mentions wakes the peer", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `fo-aa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-aa2-${uid}` });

      const chat = await createChat(app.db, a1.agent.uuid, {
        type: "group",
        participantIds: [a2.uuid],
      });
      await sendMessage(app.db, chat.id, a1.agent.uuid, {
        source: "api",
        format: "text",
        content: "ok thanks",
        metadata: { mentions: [a2.uuid] },
      });

      expect(await notifyEntries(chat.id, a2.uuid)).toHaveLength(1);
    });

    it("agent→agent 1-on-1 with explicit mentions BUT `purpose: 'agent-final-text'` does NOT wake (bypass holds)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `fo-pa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-pa2-${uid}` });

      const chat = await createChat(app.db, a1.agent.uuid, {
        type: "group",
        participantIds: [a2.uuid],
      });
      await sendMessage(app.db, chat.id, a1.agent.uuid, {
        source: "api",
        format: "text",
        content: "final text",
        metadata: { mentions: [a2.uuid] },
        purpose: "agent-final-text",
      });

      expect(await notifyEntries(chat.id, a2.uuid)).toHaveLength(0);
    });

    it("3+ speaker group without explicit mentions wakes no one", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-3h-${uid}`, type: "human" });
      const { agent: a1 } = await createTestAgent(app, { name: `fo-3a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-3a2-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [a1.uuid, a2.uuid],
      });
      await sendMessage(
        app.db,
        chat.id,
        human.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "team status?",
        },
        { allowRecipientlessSend: true },
      );

      expect(await notifyEntries(chat.id, a1.uuid)).toHaveLength(0);
      expect(await notifyEntries(chat.id, a2.uuid)).toHaveLength(0);
    });

    it("3+ speaker group with explicit mention wakes exactly the named peer", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-3wh-${uid}`, type: "human" });
      const { agent: a1 } = await createTestAgent(app, { name: `fo-3wa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-3wa2-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [a1.uuid, a2.uuid],
      });
      await sendMessage(app.db, chat.id, human.agent.uuid, {
        source: "web",
        format: "text",
        content: `hi @${a1.name}`,
        metadata: { mentions: [a1.uuid] },
      });

      expect(await notifyEntries(chat.id, a1.uuid)).toHaveLength(1);
      expect(await notifyEntries(chat.id, a2.uuid)).toHaveLength(0);
    });
  });
});
