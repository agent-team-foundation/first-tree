import { describe, expect, it } from "vitest";
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

  it("includes replyTo recipient in recipients", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-rt1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-rt2-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a3 } = await createTestAgent(app, { name: `recip-rt3-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });

    // a1 sends a message with replyTo pointing to a3
    const original = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "original message",
      replyToInbox: a3.inboxId,
      replyToChat: chat.id,
    });

    // a2 replies to the original message
    const reply = await sendMessage(app.db, chat.id, a2.uuid, {
      format: "text",
      content: "reply",
      inReplyTo: original.message.id,
    });

    // Recipients should include a1 (chat participant) and a3 (replyTo target)
    expect(reply.recipients).toContain(a1.inboxId);
    expect(reply.recipients).toContain(a3.inboxId);
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
    expect(result.message.content).toBe("direct message");
    expect(result.recipients).toContain(a2.inboxId);
    expect(result.recipients).not.toContain(a1.inboxId);
  });
});
