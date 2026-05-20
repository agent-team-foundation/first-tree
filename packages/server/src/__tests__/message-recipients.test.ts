import { describe, expect, it } from "vitest";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("sendMessage returns recipients", () => {
  const getApp = useTestApp();

  it("returns recipient inboxIds excluding sender", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-a2-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });

    // Agent↔agent direct seeds both as mention_only (migration 0029) so the
    // recipient is only included when explicitly @-mentioned. Pass the
    // mention so this stays a recipient-shape test rather than a mode test.
    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "hello",
      metadata: { mentions: [a2.uuid] },
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
    // Phase 1 (chat-participant-mode-fix-design.md §2.1) seeds every
    // non-human agent in a group chat as `mention_only`, so an unmentioned
    // message produces 0 notifying recipients. Make a1 a `human` sender so
    // group humans (none here) and `@`-mentioned agents wake; explicitly
    // mention a2 and a3 in the body to get both into the notify=true set.
    const uid = crypto.randomUUID().slice(0, 6);
    const name1 = `recip-g1-${uid}`;
    const name2 = `recip-g2-${uid}`;
    const name3 = `recip-g3-${uid}`;
    const { agent: a1 } = await createTestAgent(app, { name: name1, type: "human" });
    const { agent: a2 } = await createTestAgent(app, { name: name2 });
    const { agent: a3 } = await createTestAgent(app, { name: name3 });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid, a3.uuid],
    });

    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: `group msg @${name2} @${name3}`,
    });

    expect(result.recipients).toHaveLength(2);
    expect(result.recipients).toContain(a2.inboxId);
    expect(result.recipients).toContain(a3.inboxId);
    // Sender should not be in recipients
    expect(result.recipients).not.toContain(a1.inboxId);
  });
});
