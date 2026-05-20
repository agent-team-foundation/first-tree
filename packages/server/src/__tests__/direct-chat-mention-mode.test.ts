import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Pins v2 chat fan-out semantics:
 *
 *   - `chat_membership.mode` is decision-inert; every freshly-written
 *     speaker row stores the constant `'mention_only'` regardless of chat
 *     type / agent type / chat size (no more `defaultParticipantMode`
 *     derivation).
 *   - `notify=true` is driven by explicit signals — `addressedToAgentIds`,
 *     `metadata.mentions`, or the **1:1 implicit wake** (a chat with
 *     exactly two speakers treats the non-sender peer as implicitly
 *     addressed; covers human↔agent and agent↔agent symmetrically).
 *   - Silent-send and `purpose: "agent-final-text"` still force
 *     notify=false for every row.
 *
 * See proposals/hub-chat-message-v2-simplify-mode.20260520.md.
 */
describe("v2 chat membership + fan-out semantics", () => {
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
      // v2: no more "human peer → full" derivation. Both rows store the
      // constant `mention_only`. Fan-out wake decisions read membership
      // shape (1:1 implicit wake) instead of the column.
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

  describe("fan-out semantics under the v2 1:1 implicit wake rule", () => {
    it("human→agent 1-on-1 without `@` wakes the agent (1:1 implicit wake)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-h-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `fo-ha-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [agent.uuid],
      });
      await sendMessage(app.db, chat.id, human.agent.uuid, {
        source: "web",
        format: "text",
        content: "what's the date?",
      });

      const active = await notifyEntries(chat.id, agent.uuid);
      expect(active).toHaveLength(1);
    });

    it("agent→human 1-on-1 without `@` STILL wakes the human (symmetric)", async () => {
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
      });

      const active = await notifyEntries(chat.id, human.agent.uuid);
      expect(active).toHaveLength(1);
    });

    it("agent→agent 1-on-1 without `@` wakes the peer (v2 1:1 implicit wake)", async () => {
      // v2 behavioural change vs. v1 / migration 0029: a size-2 chat is a
      // tight pair (think delegated subtask), so an unmentioned send still
      // wakes the peer. Loop prevention now lives client-side
      // (silent-turn protocol in `result-sink`) — the v1 mode_only
      // anti-echo guard is no longer the structural backstop.
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
      });

      const active = await notifyEntries(chat.id, a2.uuid);
      expect(active).toHaveLength(1);
    });

    it("agent→agent 1-on-1 with `purpose: 'agent-final-text'` still does NOT wake (bypass holds)", async () => {
      // Force-silent bypass continues to shadow the 1:1 implicit wake.
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
        purpose: "agent-final-text",
      });

      const active = await notifyEntries(chat.id, a2.uuid);
      expect(active).toHaveLength(0);
    });

    it("3+ speaker group without `@` does NOT wake anyone (only explicit mention / addressed)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-3h-${uid}`, type: "human" });
      const { agent: a1 } = await createTestAgent(app, { name: `fo-3a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-3a2-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "group",
        participantIds: [a1.uuid, a2.uuid],
      });
      await sendMessage(app.db, chat.id, human.agent.uuid, {
        source: "web",
        format: "text",
        content: `hi @${a1.name}`,
        // Resolve uuid via mentions so server doesn't have to read content.
        metadata: { mentions: [a1.uuid] },
      });

      const a1Active = await notifyEntries(chat.id, a1.uuid);
      expect(a1Active).toHaveLength(1);
      const a2Active = await notifyEntries(chat.id, a2.uuid);
      expect(a2Active).toHaveLength(0);
    });
  });
});
