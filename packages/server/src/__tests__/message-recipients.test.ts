import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat } from "../services/chat.js";
import { sendMessage, sendToAgent } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("sendMessage returns recipients", () => {
  const getApp = useTestApp();

  it("returns recipient inboxIds excluding sender", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-a2-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "direct",
      participantIds: [a2.uuid],
    });

    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "hello",
    });

    expect(result.message).toBeDefined();
    expect(result.message.content).toBe("hello");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]).toBe(a2.inboxId);
  });

  it("returns empty recipients when no other participants", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-solo-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [],
    });

    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "talking to myself",
    });

    expect(result.recipients).toHaveLength(0);
  });

  it("returns multiple recipients in group chat", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-g1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-g2-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a3 } = await createTestAgent(app, { name: `recip-g3-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid, a3.uuid],
    });

    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "group msg",
    });

    expect(result.recipients).toHaveLength(2);
    expect(result.recipients).toContain(a2.inboxId);
    expect(result.recipients).toContain(a3.inboxId);
    // Sender should not be in recipients
    expect(result.recipients).not.toContain(a1.inboxId);
  });

  it("rejects replyToInbox that does not belong to the sender", async () => {
    // Sender-ownership guard: the `replyTo` envelope is a sender-declared
    // routing promise, not a free-form attachment. Letting a caller name
    // someone else's inbox would let an agent spam a third party's inbox by
    // baiting replies — see proposals/hub-agent-messaging-reply-and-mentions §3.1.
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-rti1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-rti2-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a3 } = await createTestAgent(app, { name: `recip-rti3-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });

    await expect(
      sendMessage(app.db, chat.id, a1.uuid, {
        format: "text",
        content: "original",
        replyToInbox: a3.inboxId, // NOT a1's inbox — should be rejected.
        replyToChat: chat.id,
      }),
    ).rejects.toThrow(/replyToInbox/);
  });

  it("replyTo routing writes an extra inbox_entry for the sender's own inbox in the replyTo chat", async () => {
    // When the sender legitimately uses their OWN inbox as replyToInbox and
    // points replyToChat at a different chat, a reply should produce a
    // second inbox_entry for that sender in the replyTo chat (on top of the
    // fan-out entry in the reply's own chat). This is the core routing
    // primitive from proposal §3.3 Case A.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { agent: a1 } = await createTestAgent(app, { name: `recip-rt1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-rt2-${uid}` });

    const chat1 = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    const chat2 = await createChat(app.db, a1.uuid, { type: "group", participantIds: [] });

    // a1 declares "replies to this message should also land in chat2".
    const original = await sendMessage(app.db, chat1.id, a1.uuid, {
      format: "text",
      content: "original",
      replyToInbox: a1.inboxId,
      replyToChat: chat2.id,
    });

    // a2 replies in chat1.
    const reply = await sendMessage(app.db, chat1.id, a2.uuid, {
      format: "text",
      content: "reply",
      inReplyTo: original.message.id,
    });

    // a1's inbox received two rows for the reply: one per chat. Query by
    // (inboxId, messageId) so we see both copies the fan-out + replyTo
    // routing produced. Asserting on chatIds pins the routing behaviour.
    const rows = await app.db
      .select({ chatId: inboxEntries.chatId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a1.inboxId), eq(inboxEntries.messageId, reply.message.id)));
    expect(rows.map((r) => r.chatId).sort()).toEqual([chat1.id, chat2.id].sort());
  });

  it("sendToAgent returns recipients", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-dm1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-dm2-${crypto.randomUUID().slice(0, 6)}` });
    if (!a2.name) throw new Error("Expected a2.name to be set");

    const result = await sendToAgent(app.db, a1.uuid, a2.name, {
      format: "text",
      content: "direct message",
    });

    expect(result.message).toBeDefined();
    // Server prepends @<targetName> on agent-to-agent sends — see
    // agent-send-mention-injection.test.ts.
    expect(result.message.content).toBe(`@${a2.name} direct message`);
    expect(result.recipients).toContain(a2.inboxId);
    expect(result.recipients).not.toContain(a1.inboxId);
  });
});
