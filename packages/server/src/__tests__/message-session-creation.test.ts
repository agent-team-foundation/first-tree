import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { suspendAgent } from "../services/agent.js";
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

    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    // Agent↔agent direct seeds both as mention_only (migration 0029). The
    // predictive activation only fires for notify=true rows, so the message
    // must @ the recipient to count as an active fan-out target.
    await sendMessage(app.db, chat.id, a1.uuid, {
      source: "api",
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

    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    await app.db.insert(agentChatSessions).values({ agentId: a2.uuid, chatId: chat.id, state: "evicted" });

    // mention_only direct (migration 0029): @ to wake + revive.
    await sendMessage(app.db, chat.id, a1.uuid, {
      source: "api",
      format: "text",
      content: "ping",
      metadata: { mentions: [a2.uuid] },
    });

    expect(await readSessionState(app, a2.uuid, chat.id)).toBe("active");
  });

  it("group chat fan-out activates every notify=true participant (N1-B)", async () => {
    // Under the explicit-only contract, a group send wakes only the
    // peers declared in `metadata.mentions`. Declare both so they wake
    // into `active` — the test's invariant ("every notify=true
    // participant becomes active") is preserved.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const r1Name = `g-r1-${uid}`;
    const r2Name = `g-r2-${uid}`;
    const { agent: sender } = await createTestAgent(app, { name: `g-snd-${uid}`, type: "human" });
    const { agent: r1 } = await createTestAgent(app, { name: r1Name });
    const { agent: r2 } = await createTestAgent(app, { name: r2Name });

    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [r1.uuid, r2.uuid],
    });

    await sendMessage(app.db, chat.id, sender.uuid, {
      source: "api",
      format: "text",
      content: `team! @${r1Name} @${r2Name}`,
      metadata: { mentions: [r1.uuid, r2.uuid] },
    });

    expect(await readSessionState(app, r1.uuid, chat.id)).toBe("active");
    expect(await readSessionState(app, r2.uuid, chat.id)).toBe("active");
    // Sender does NOT get a session of its own — fan-out filters senderId out.
    expect(await readSessionState(app, sender.uuid, chat.id)).toBeNull();
  });

  it("silent context (3+ speaker group, no mention) → no active session for non-mentioned peers", async () => {
    // v2: `chat_membership.mode` is decision-inert. A group send with no
    // explicit `@mention` / `receiverNames` / `addressedToAgentIds` produces
    // zero `notify=true` fan-out rows (the 1:1 implicit wake does not apply
    // — `participants.length > 2`), so no peer's session is activated.
    // Only an explicitly mentioned peer flips to `active`.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const r1Name = `s-r1-${uid}`;
    const { agent: sender } = await createTestAgent(app, { name: `s-snd-${uid}`, type: "human" });
    const { agent: mentioned } = await createTestAgent(app, { name: r1Name });
    const { agent: silent } = await createTestAgent(app, { name: `s-mo-${uid}` });

    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [mentioned.uuid, silent.uuid],
    });

    // No @, no metadata.mentions → nobody wakes (silent fan-out).
    await sendMessage(app.db, chat.id, sender.uuid, { source: "web", format: "text", content: "hello team" });
    expect(await readSessionState(app, mentioned.uuid, chat.id)).toBeNull();
    expect(await readSessionState(app, silent.uuid, chat.id)).toBeNull();

    // Now explicitly mention `mentioned` → only that peer wakes.
    await sendMessage(app.db, chat.id, sender.uuid, {
      source: "web",
      format: "text",
      content: `please look @${r1Name}`,
      metadata: { mentions: [mentioned.uuid] },
    });
    expect(await readSessionState(app, mentioned.uuid, chat.id)).toBe("active");
    expect(await readSessionState(app, silent.uuid, chat.id)).toBeNull();
  });

  it("does not predictively activate a suspended recipient", async () => {
    const app = getApp();
    const { agent: sender } = await createTestAgent(app, { name: `sus-src-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: suspended } = await createTestAgent(app, { name: `sus-target-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [suspended.uuid],
    });
    await suspendAgent(app.db, suspended.uuid);

    await sendMessage(app.db, chat.id, sender.uuid, {
      source: "api",
      format: "text",
      content: "history only",
      purpose: "agent-final-text",
    });

    expect(await readSessionState(app, suspended.uuid, chat.id)).toBeNull();
  });
});
