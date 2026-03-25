import { afterAll, describe, expect, it } from "vitest";
import { createChat } from "../services/chat.js";
import { sendMessage, sendToAgent } from "../services/message.js";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("sendMessage returns recipients", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("returns recipient inboxIds excluding sender", async () => {
    const app = await appPromise;
    const { agent: a1 } = await createTestAgent(app, { id: `recip-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { id: `recip-a2-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.id, {
      type: "direct",
      participantIds: [a2.id],
    });

    const result = await sendMessage(app.db, chat.id, a1.id, {
      format: "text",
      content: "hello",
    });

    expect(result.message).toBeDefined();
    expect(result.message.content).toBe("hello");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]).toBe(a2.inboxId);
  });

  it("returns empty recipients when no other participants", async () => {
    const app = await appPromise;
    const { agent: a1 } = await createTestAgent(app, { id: `recip-solo-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.id, {
      type: "group",
      participantIds: [],
    });

    const result = await sendMessage(app.db, chat.id, a1.id, {
      format: "text",
      content: "talking to myself",
    });

    expect(result.recipients).toHaveLength(0);
  });

  it("returns multiple recipients in group chat", async () => {
    const app = await appPromise;
    const { agent: a1 } = await createTestAgent(app, { id: `recip-g1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { id: `recip-g2-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a3 } = await createTestAgent(app, { id: `recip-g3-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.id, {
      type: "group",
      participantIds: [a2.id, a3.id],
    });

    const result = await sendMessage(app.db, chat.id, a1.id, {
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
    const app = await appPromise;
    const { agent: a1 } = await createTestAgent(app, { id: `recip-rt1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { id: `recip-rt2-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a3 } = await createTestAgent(app, { id: `recip-rt3-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.id, {
      type: "group",
      participantIds: [a2.id],
    });

    // a1 sends a message with replyTo pointing to a3
    const original = await sendMessage(app.db, chat.id, a1.id, {
      format: "text",
      content: "original message",
      replyToInbox: a3.inboxId,
      replyToChat: chat.id,
    });

    // a2 replies to the original message
    const reply = await sendMessage(app.db, chat.id, a2.id, {
      format: "text",
      content: "reply",
      inReplyTo: original.message.id,
    });

    // Recipients should include a1 (chat participant) and a3 (replyTo target)
    expect(reply.recipients).toContain(a1.inboxId);
    expect(reply.recipients).toContain(a3.inboxId);
  });

  it("sendToAgent returns recipients", async () => {
    const app = await appPromise;
    const { agent: a1 } = await createTestAgent(app, { id: `recip-dm1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { id: `recip-dm2-${crypto.randomUUID().slice(0, 6)}` });

    const result = await sendToAgent(app.db, a1.id, a2.id, {
      format: "text",
      content: "direct message",
    });

    expect(result.message).toBeDefined();
    expect(result.message.content).toBe("direct message");
    expect(result.recipients).toContain(a2.inboxId);
    expect(result.recipients).not.toContain(a1.inboxId);
  });
});
