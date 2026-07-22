import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import { createMeChat, listMeChats } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, createTestAgent, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

/**
 * 1:1 chat wake-up + unread badge — explicit-mention contract.
 *
 * Background: pre-retire of content extraction the server had two
 * implicit 1:1 mechanisms — `isOneOnOne` in fan-out (auto-wake the
 * peer) and `dmAutoProjection` (auto-bump the unread badge). Both
 * fired on every 2-speaker send regardless of whether the caller
 * declared any routing.
 *
 * Both mechanisms have been retired. In the new world, clients (the
 * web composer is the main one) inject the peer's uuid into
 * `metadata.mentions` for 2-speaker chats, and the server treats that
 * exactly like any other explicit mention — notify=true for the peer.
 * The unread badge (`unread_mention_count`) is a human-attention signal:
 * it bumps only when the mention target is a HUMAN, so a mentioned agent
 * is woken via the inbox but raises no red dot.
 *
 * Invariants this file pins:
 *   1. Human → agent DM with explicit mentions wakes the agent but
 *      raises NO unread red dot (the agent is a non-human target).
 *   2. Agent → human DM with explicit mentions wakes the human and
 *      bumps the human's unread counter.
 *   3. Agent ↔ agent DM with explicit mentions wakes the peer (no red dot).
 *   4. A DM send WITHOUT explicit mentions (would only happen via a
 *      pre-explicit-contract caller) does NOT wake the peer and does
 *      NOT bump the badge — this is the regression guard for the
 *      retired implicit mechanisms.
 *   5. DM content is never rewritten with a `@<peer-name>` prefix on
 *      the web path (`normalizeMentionsInContent` is off there).
 *   6. Group chats with explicit mentions wake exactly the named peers.
 */
describe("1:1 chat wake-up + unread badge (explicit-mention contract)", () => {
  const getApp = useTestApp();

  async function loadUnread(
    chatId: string,
    agentUuid: string,
    memberId: string,
    organizationId: string,
  ): Promise<number> {
    const app = getApp();
    const { priorityRows, rows } = await listMeChats(
      app.db,
      agentUuid,
      memberId,
      organizationId,
      {
        limit: 10,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    // A `request` DM opens a request, routing the chat into the attention group
    // rather than ordinary `rows` — search all groups for the unread counter.
    return (
      [...priorityRows.attention, ...priorityRows.pinned, ...rows].find((r) => r.chatId === chatId)
        ?.unreadMentionCount ?? 0
    );
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

  it("human → agent DM with explicit mentions wakes the agent but raises no unread red dot (non-human mention)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dmh2a-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, admin.humanAgentUuid, {
      source: "api",
      format: "text",
      content: "hi",
      // The web composer auto-injects the peer's uuid for 2-speaker chats;
      // simulate that here.
      metadata: { mentions: [peer.agent.uuid] },
    });

    // The agent is still woken via the inbox notify path…
    expect(await notifyInboxRows(chatId, peer.agent.uuid)).toHaveLength(1);
    // …but the unread-mention red dot is a human-attention signal, so
    // mentioning a non-human agent raises no red dot for that agent.
    expect(await loadUnread(chatId, peer.agent.uuid, peer.memberId, peer.organizationId)).toBe(0);
  });

  it("agent → human DM ask (format=request) wakes the human and bumps the unread counter", async () => {
    // An agent asks a human with `chat ask` (format=request), which wakes the
    // human and counts unread. (A plain `chat send <human>` is also allowed as
    // a free reply; this case exercises the ask path.)
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dma2h-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "request",
      content: "ack — quick check",
      metadata: { mentions: [admin.humanAgentUuid], request: { question: "ok?" } },
    });

    expect(await notifyInboxRows(chatId, admin.humanAgentUuid)).toHaveLength(1);
    expect(await loadUnread(chatId, admin.humanAgentUuid, admin.memberId, admin.organizationId)).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("agent ↔ agent DM with explicit mentions wakes the peer", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `aa1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `aa2-${uid}` });

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

    // a2 is woken via the inbox, but as a non-human mention target it gets
    // no unread red dot — red dots are a human-attention signal.
    expect(await notifyInboxRows(chat.id, a2.uuid)).toHaveLength(1);
    expect(await loadUnread(chat.id, a2.uuid, a1.memberId, a1.organizationId)).toBe(0);
  });

  it("DM without explicit mentions does NOT wake the peer (the retired 1:1 implicit-wake regression guard)", async () => {
    // The previous server-side `isOneOnOne` branch in fan-out would
    // have woken the peer here. Under the explicit-only contract it
    // does not — and the web composer is responsible for injecting the
    // peer's uuid into `metadata.mentions` on the wire. This pin
    // protects against accidental re-introduction of the implicit path.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dmnowake-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      {
        source: "api",
        format: "text",
        content: "hi, no mentions",
      },
      { allowRecipientlessSend: true },
    );

    expect(await notifyInboxRows(chatId, peer.agent.uuid)).toHaveLength(0);
    expect(await loadUnread(chatId, peer.agent.uuid, peer.memberId, peer.organizationId)).toBe(0);
  });

  it("DM content is never rewritten with `@<peer-name>` prefix on the web path", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `dmnorw-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // Web endpoint does NOT pass normalizeMentionsInContent; the human
    // typed what they typed. Even with explicit mentions, content stays
    // verbatim.
    await sendMessage(app.db, chatId, admin.humanAgentUuid, {
      source: "api",
      format: "text",
      content: "plain hi",
      metadata: { mentions: [peer.agent.uuid] },
    });

    expect(await loadMessageContent(chatId)).toBe("plain hi");
  });

  it("group chat with explicit mentions wakes only the named peers", async () => {
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
      source: "api",
      format: "text",
      content: "heads up",
      metadata: { mentions: [a2.uuid] },
    });

    expect(await notifyInboxRows(chat.id, a2.uuid)).toHaveLength(1);
    expect(await notifyInboxRows(chat.id, a3.uuid)).toHaveLength(0);
    // a2 is woken but, as a non-human mention target, gets no unread red dot.
    expect(await loadUnread(chat.id, a2.uuid, a1.memberId, a1.organizationId)).toBe(0);
    expect(await loadUnread(chat.id, a3.uuid, a1.memberId, a1.organizationId)).toBe(0);
  });
});
