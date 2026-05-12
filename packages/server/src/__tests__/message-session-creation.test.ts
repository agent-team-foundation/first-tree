import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";
import { readPresence, readSessionState, seedPresence } from "./session-state-helpers.js";

// Predictive session-activation tests for M-plan Step 1b: sendMessage upserts
// an `active` agent_chat_sessions row for every notify=true fan-out target
// after the main transaction commits, without touching presence.lastSeenAt.

describe("sendMessage — predictive session activation (M plan Step 1b)", () => {
  const getApp = useTestApp();

  it("first message in a 1:1 chat creates an active session row without touching lastSeenAt", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `act-a-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `act-b-${crypto.randomUUID().slice(0, 6)}` });
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, a2.uuid, oldDate);

    const chat = await createChat(app.db, a1.uuid, { type: "direct", participantIds: [a2.uuid] });
    // Agent↔agent direct seeds both as mention_only (migration 0029). The
    // predictive activation only fires for notify=true rows, so the message
    // must @ the recipient to count as an active fan-out target.
    await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "hi",
      metadata: { mentions: [a2.uuid] },
    });

    expect(await readSessionState(app, a2.uuid, chat.id)).toBe("active");
    const presence = await readPresence(app, a2.uuid);
    expect(presence?.lastSeenAt?.getTime()).toBe(oldDate.getTime());
    expect(presence?.activeSessions).toBe(1);
  });

  it("revives an evicted session back to active on next message (N2-A)", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `rev-a-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `rev-b-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, { type: "direct", participantIds: [a2.uuid] });
    await app.db.insert(agentChatSessions).values({ agentId: a2.uuid, chatId: chat.id, state: "evicted" });

    // mention_only direct (migration 0029): @ to wake + revive.
    await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "ping",
      metadata: { mentions: [a2.uuid] },
    });

    expect(await readSessionState(app, a2.uuid, chat.id)).toBe("active");
  });

  it("group chat fan-out activates every notify=true participant (N1-B)", async () => {
    const app = getApp();
    const { agent: sender } = await createTestAgent(app, { name: `g-snd-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: r1 } = await createTestAgent(app, { name: `g-r1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: r2 } = await createTestAgent(app, { name: `g-r2-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [r1.uuid, r2.uuid],
    });

    await sendMessage(app.db, chat.id, sender.uuid, { format: "text", content: "team!" });

    expect(await readSessionState(app, r1.uuid, chat.id)).toBe("active");
    expect(await readSessionState(app, r2.uuid, chat.id)).toBe("active");
    // Sender does NOT get a session of its own — fan-out filters senderId out.
    expect(await readSessionState(app, sender.uuid, chat.id)).toBeNull();
  });

  it("silent context (mention_only without mention) does NOT create an active session", async () => {
    const app = getApp();
    const { agent: sender } = await createTestAgent(app, { name: `s-snd-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: full } = await createTestAgent(app, { name: `s-full-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: silent } = await createTestAgent(app, { name: `s-mo-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [full.uuid, silent.uuid],
    });

    // Flip silent to mention_only mode: without an @mention the fan-out marks
    // its row notify=false, so the predictive activation must skip it.
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, silent.uuid)));

    await sendMessage(app.db, chat.id, sender.uuid, { format: "text", content: "hello team" });

    expect(await readSessionState(app, full.uuid, chat.id)).toBe("active");
    expect(await readSessionState(app, silent.uuid, chat.id)).toBeNull();
  });
});
