import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat, findOrCreateDirectChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Pins migration 0029's "agent-only direct chat → mention_only" rule.
 *
 * Background: in agent↔agent direct chats both participants used to default
 * to `full`, which made every reply wake the peer unconditionally and the
 * two agents looped on courtesy turns ("ok thanks" / "received") forever.
 * Migration 0029 (and the matching seed in `findOrCreateDirectChat` /
 * `createChat`) flips both ends to `mention_only` so engagement requires an
 * explicit `@`. Human↔agent direct keeps `full` because in a 1:1 with a
 * person every message is implicitly addressed to the agent.
 */
describe("direct chat default mode (migration 0029)", () => {
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

  describe("findOrCreateDirectChat seeds the right modes", () => {
    it("agent↔agent → both `mention_only`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `dc-aa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `dc-aa2-${uid}` });

      const chat = await findOrCreateDirectChat(app.db, a1.agent.uuid, a2.uuid);
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["mention_only", "mention_only"]);
    });

    it("human↔agent → both `full`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `dc-hu-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `dc-ag-${uid}` });

      const chat = await findOrCreateDirectChat(app.db, human.agent.uuid, agent.uuid);
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["full", "full"]);
    });

    it("autonomous_agent↔personal_assistant → both `mention_only` (rule keys on `type !== 'human'`, not a whitelist)", async () => {
      // Pin the rule against the kind of refactor that would replace
      // `type !== 'human'` with a positive whitelist like
      // `type === 'autonomous_agent'`. `personal_assistant` is also a
      // non-human agent and must follow the same loop-prevention default.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const auto = await createTestAgent(app, { name: `dc-au-${uid}`, type: "autonomous_agent" });
      const { agent: pa } = await createTestAgent(app, { name: `dc-pa-${uid}`, type: "personal_assistant" });

      const chat = await findOrCreateDirectChat(app.db, auto.agent.uuid, pa.uuid);
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["mention_only", "mention_only"]);
    });
  });

  describe("createChat seeds the right modes", () => {
    it("type='direct' with two agents → both `mention_only`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `cc-aa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `cc-aa2-${uid}` });

      const chat = await createChat(app.db, a1.agent.uuid, {
        type: "direct",
        participantIds: [a2.uuid],
      });
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["mention_only", "mention_only"]);
    });

    it("type='direct' with a human → both `full`", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `cc-h-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `cc-a-${uid}` });

      const chat = await createChat(app.db, human.agent.uuid, {
        type: "direct",
        participantIds: [agent.uuid],
      });
      const modes = await loadModes(chat.id);
      expect(modes.map((m) => m.mode).sort()).toEqual(["full", "full"]);
    });

    it("type='group' with only non-human agents seeds everyone as `mention_only` (Phase 1)", async () => {
      // Phase 1 fixed the bug where a born-as-group chat with non-human
      // participants kept them in `'full'` — silently breaking the
      // mention_only fanout rule (see docs/chat-participant-mode-fix-design.md
      // §1.1). The post-fix invariant: in any group chat, every non-human
      // participant is seeded `mention_only`. Humans (none here) stay `full`.
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

  describe("fan-out semantics under the new mode defaults", () => {
    it("agent→agent direct without `@` produces a SILENT row, not an active wake", async () => {
      // The exact bug we're fixing: A's "ok thanks" used to wake B, who
      // then replied "received", which woke A, … forever. Under 0029 the
      // courtesy turn lands as a silent context row instead of a notify=true
      // entry, so the loop dies after the explicit-mention round-trip is over.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `fo-aa1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-aa2-${uid}` });

      const chat = await findOrCreateDirectChat(app.db, a1.agent.uuid, a2.uuid);
      await sendMessage(app.db, chat.id, a1.agent.uuid, {
        format: "text",
        content: "ok thanks",
      });

      const active = await notifyEntries(chat.id, a2.uuid);
      expect(active).toHaveLength(0);
    });

    it("agent→agent direct WITH `@<peer>` wakes the peer", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `fo-mn1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `fo-mn2-${uid}` });

      const chat = await findOrCreateDirectChat(app.db, a1.agent.uuid, a2.uuid);
      await sendMessage(app.db, chat.id, a1.agent.uuid, {
        format: "text",
        content: "ping",
        metadata: { mentions: [a2.uuid] },
      });

      const active = await notifyEntries(chat.id, a2.uuid);
      expect(active).toHaveLength(1);
    });

    it("human→agent direct without `@` STILL wakes the agent", async () => {
      // The DX guarantee: a human writing in their own DM never has to type
      // `@<assistant>`. Falls out naturally because the agent stays in
      // `full` mode whenever a human is in the chat.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-h-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `fo-ha-${uid}` });

      const chat = await findOrCreateDirectChat(app.db, human.agent.uuid, agent.uuid);
      await sendMessage(app.db, chat.id, human.agent.uuid, {
        format: "text",
        content: "what's the date?",
      });

      const active = await notifyEntries(chat.id, agent.uuid);
      expect(active).toHaveLength(1);
    });

    it("agent→human direct without `@` STILL wakes the human (symmetric DX)", async () => {
      // Mirror of the case above — agents replying to humans in a DM
      // shouldn't have to add a `@<human>` prefix to be heard. The human
      // is `full` so they're always notified.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `fo-h2-${uid}`, type: "human" });
      const { agent } = await createTestAgent(app, { name: `fo-ha2-${uid}` });

      const chat = await findOrCreateDirectChat(app.db, human.agent.uuid, agent.uuid);
      await sendMessage(app.db, chat.id, agent.uuid, {
        format: "text",
        content: "today is 2026-04-29",
      });

      const active = await notifyEntries(chat.id, human.agent.uuid);
      expect(active).toHaveLength(1);
    });
  });
});

/**
 * Pins the fix for issue #283: when a (human, delegate) pair has multiple
 * direct chats — which the product explicitly allows — `findOrCreateDirectChat`
 * MUST return the same chat across calls. Previously the lookup had no
 * `ORDER BY`, so the row returned was effectively arbitrary, and GitHub
 * webhook fan-out landed in non-deterministic chats / split across them on
 * near-simultaneous retries.
 */
describe("findOrCreateDirectChat deterministic selection (issue #283)", () => {
  const getApp = useTestApp();

  it("returns the earliest-created direct chat every call when multiple exist for the same pair", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { name: `det-h-${uid}`, type: "human" });
    const { agent } = await createTestAgent(app, { name: `det-a-${uid}` });

    // Create two direct chats for the same pair. Product allows this — users
    // can "New chat" from the workspace whenever they like.
    const first = await createChat(app.db, human.agent.uuid, {
      type: "direct",
      participantIds: [agent.uuid],
    });
    // Force a distinct created_at so the ordering is unambiguous regardless
    // of clock resolution on the test runner.
    await new Promise((r) => setTimeout(r, 5));
    const second = await createChat(app.db, human.agent.uuid, {
      type: "direct",
      participantIds: [agent.uuid],
    });

    expect(first.id).not.toBe(second.id);

    // Repeated lookup must always land on the earliest chat.
    const a = await findOrCreateDirectChat(app.db, human.agent.uuid, agent.uuid);
    const b = await findOrCreateDirectChat(app.db, human.agent.uuid, agent.uuid);
    const c = await findOrCreateDirectChat(app.db, agent.uuid, human.agent.uuid);

    expect(a.id).toBe(first.id);
    expect(b.id).toBe(first.id);
    expect(c.id).toBe(first.id);
  });
});
