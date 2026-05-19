import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import { createMeChat, listMeChats } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Direct-chat auto-mention for the chat-first workspace.
 *
 * Background: `applyAfterFanOut` increments `chat_user_state.unread_mention_count`
 * only when the message names someone via `@<token>` or `metadata.mentions`. In
 * a 1-on-1 the recipient is implicit by chat structure, so `extractMentions`
 * returns [] and the conversation-list badge never rises — DMs would always
 * show zero unread.
 *
 * Fix: when `chat.type === "direct"`, `services/message.ts` builds a
 * `projectionMentions` list that includes every non-sender speaker and passes
 * it to `applyAfterFanOut` for the counter bump. The original `mergedMentions`
 * is untouched so fan-out, `metadata.mentions`, and the `mention_only` anti-
 * loop rule from migration 0029 all behave exactly as before.
 *
 * Invariants this file pins:
 *   1. Human → agent DM bumps the agent's unread counter on plain text.
 *   2. Agent → human DM bumps the human's unread counter on plain text.
 *   3. Agent ↔ agent DM (`mention_only`) bumps the peer's counter BUT
 *      still produces a silent inbox row (no `notify = true` wake) — the
 *      counter is for the UI, the fan-out mute is for the loop-free runtime.
 *   4. Plain-text DMs are NOT rewritten — content stays exactly as sent
 *      (no `@<peer-name>` prepend by `normalizeMentionsInContent`).
 *   5. Group chats keep the explicit-`@` discipline — a plain-text group
 *      message still produces zero counter bumps.
 */
describe("direct-chat auto-mention for chat-list unread counter", () => {
  const getApp = useTestApp();

  async function loadUnread(chatId: string, agentUuid: string, organizationId: string): Promise<number> {
    const app = getApp();
    const { rows } = await listMeChats(app.db, agentUuid, organizationId, {
      limit: 10,
      filter: "all",
      engagement: "all",
    });
    return rows.find((r) => r.chatId === chatId)?.unreadMentionCount ?? 0;
  }

  async function notifyInboxRows(chatId: string, agentUuid: string) {
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

  async function loadMessageContent(chatId: string): Promise<string> {
    const app = getApp();
    const [row] = await app.db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .limit(1);
    return typeof row?.content === "string" ? row.content : "";
  }

  it("human → agent DM: agent's unread counter bumps on plain text", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dmh2a-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, admin.humanAgentUuid, {
      format: "text",
      content: "hi, no explicit @ here",
    });

    expect(await loadUnread(chatId, peer.agent.uuid, peer.organizationId)).toBeGreaterThanOrEqual(1);
  });

  it("agent → human DM: human's unread counter bumps on plain text", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dma2h-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      format: "text",
      content: "ack",
    });

    expect(await loadUnread(chatId, admin.humanAgentUuid, admin.organizationId)).toBeGreaterThanOrEqual(1);
  });

  it("agent ↔ agent DM: counter bumps but inbox stays silent (migration 0029 preserved)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `aa1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `aa2-${uid}` });

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });
    await sendMessage(app.db, chat.id, a1.agent.uuid, {
      format: "text",
      content: "ok thanks",
    });

    // Counter side: a2's unread for this chat bumps to 1 (the chat-list signal).
    expect(await loadUnread(chat.id, a2.uuid, a1.organizationId)).toBeGreaterThanOrEqual(1);

    // Inbox side: no notify=true row — a2's runtime should NOT wake on a
    // plain-text courtesy reply, matching migration 0029's anti-loop intent.
    expect(await notifyInboxRows(chat.id, a2.uuid)).toHaveLength(0);
  });

  it("DM content is never rewritten with `@<peer-name>` prefix", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dmnorw-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "text", content: "plain hi" },
      // Match the production agent send path which sets this flag.
      { normalizeMentionsInContent: true },
    );

    expect(await loadMessageContent(chatId)).toBe("plain hi");
  });

  it("silent-send DM (text = '@peer' only) does NOT bump the peer's counter", async () => {
    // Silent-send invariant (services/message.ts step 2e): a message whose
    // text is purely `@<name>` tokens with no body is recorded for history
    // but every fan-out row gets `notify=false`. The badge must respect
    // the same intent — bumping `unread_mention_count` would contradict
    // the "no user-visible signal" guarantee that callers (agent runtime
    // `result-sink`, AskUserQuestion, etc.) rely on for silent turns.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dmslnt-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, admin.humanAgentUuid, {
      format: "text",
      content: `@${peer.agent.name}`,
    });

    expect(await loadUnread(chatId, peer.agent.uuid, peer.organizationId)).toBe(0);
  });

  it("group chat: plain text still produces zero counter bumps (no auto-mention)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `g1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `g2-${uid}` });
    const { agent: a3 } = await createTestAgent(app, { name: `g3-${uid}` });

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "group",
      participantIds: [a2.uuid, a3.uuid],
    });
    await sendMessage(app.db, chat.id, a1.agent.uuid, {
      format: "text",
      content: "anyone around",
    });

    expect(await loadUnread(chat.id, a2.uuid, a1.organizationId)).toBe(0);
    expect(await loadUnread(chat.id, a3.uuid, a1.organizationId)).toBe(0);
  });
});
