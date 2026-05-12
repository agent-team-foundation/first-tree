import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { addParticipant, createChat, ensureParticipant, joinChat } from "../services/chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Covers the direct → group upgrade rule introduced by the proposal: when a
 * direct chat gains a third participant, its type flips to "group" and all
 * non-human agent participants become `mention_only`. Humans stay `full`
 * (they're still in supervise-all mode).
 */
describe("chat upgrade — direct to group", () => {
  const getApp = useTestApp();

  async function loadParticipant(chatId: string, agentId: string) {
    const app = getApp();
    const [row] = await app.db
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)));
    return row;
  }

  async function loadChatType(chatId: string) {
    const app = getApp();
    const [row] = await app.db.select().from(chats).where(eq(chats.id, chatId));
    return row?.type;
  }

  it("flips direct → group and moves existing agents to mention_only when a 3rd agent joins via addParticipant", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `up-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `up-a2-${uid}` });
    const { agent: a3 } = await createTestAgent(app, { name: `up-a3-${uid}` });

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "direct",
      participantIds: [a2.uuid],
    });

    // Both agents start as `mention_only` because no human is in the chat —
    // see migration 0029 / `createChat`'s direct-agent-only branch. The
    // upgrade rule is therefore a no-op for the existing two on this path,
    // but we still want to assert it doesn't downgrade them or break.
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");

    // Third autonomous agent joins. Phase 1: caller no longer passes `mode`;
    // server derives it from `(chats.type, agents.type)`. For a non-human
    // agent landing in a (now) group chat the expected mode is
    // `mention_only`.
    await addParticipant(app.db, chat.id, a1.agent.uuid, { agentId: a3.uuid });

    expect(await loadChatType(chat.id)).toBe("group");
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");
    // a3 is a non-human agent joining a group chat → server-derived
    // mode = `mention_only` (this was `'full'` pre-Phase-1, the bug the
    // refactor fixes).
    expect((await loadParticipant(chat.id, a3.uuid))?.mode).toBe("mention_only");
  });

  it("upgrades the chat and keeps the joining human at full mode (Web-console join path)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `hup-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `hup-a2-${uid}` });

    // A human agent owned by the same member who manages a1 — joinChat
    // authorises via managerId.
    const { agent: human } = await createTestAgent(app, {
      name: `hup-human-${uid}`,
      type: "human",
    });
    // Rewrite managerId so joinChat permits the join (supervision must match
    // at least one existing participant).
    const { agents: agentsTable } = await import("../db/schema/agents.js");
    // a1's member manages both a1 and the human agent row by default; but
    // the human agent we just created belongs to a *different* admin. Force
    // it to the same manager so the join is authorised.
    await app.db.update(agentsTable).set({ managerId: a1.memberId }).where(eq(agentsTable.uuid, human.uuid));
    await app.db.update(agentsTable).set({ managerId: a1.memberId }).where(eq(agentsTable.uuid, a2.uuid));

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "direct",
      participantIds: [a2.uuid],
    });

    await joinChat(app.db, chat.id, a1.memberId, human.uuid);

    expect(await loadChatType(chat.id)).toBe("group");
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, human.uuid))?.mode).toBe("full");
  });

  it("is a no-op on a chat that is already a group (doesn't re-flip existing participant modes)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `grp-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `grp-a2-${uid}` });
    const { agent: a3 } = await createTestAgent(app, { name: `grp-a3-${uid}` });
    const { agent: a4 } = await createTestAgent(app, { name: `grp-a4-${uid}` });

    // Born as a group — a2 starts in mention_only, a1 in full (owner).
    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "group",
      participantIds: [a2.uuid, a3.uuid],
    });
    // Manually pin a1 to full, a2 to mention_only so we can detect any
    // inadvertent downgrade.
    await app.db
      .update(chatMembership)
      .set({ mode: "full" })
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, a1.agent.uuid)));
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, a2.uuid)));

    await addParticipant(app.db, chat.id, a1.agent.uuid, { agentId: a4.uuid });

    expect(await loadChatType(chat.id)).toBe("group");
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("full");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");
    // a4 is a non-human agent joining a group chat → server-derived
    // mode = `mention_only`.
    expect((await loadParticipant(chat.id, a4.uuid))?.mode).toBe("mention_only");
  });

  it("upgrades when a third participant joins via ensureParticipant (web-UI auto-join path)", async () => {
    // The hub web console's "send a message in this chat" handler funnels
    // through ensureParticipant to auto-add the sender. This path bypassed
    // the upgrade logic initially, leaving b1+tester in `full` mode when a
    // human entered an existing direct chat — the exact shape that kept
    // producing emoji echo loops in local testing.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `ensure-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `ensure-a2-${uid}` });
    const { agent: human } = await createTestAgent(app, { name: `ensure-h-${uid}`, type: "human" });

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "direct",
      participantIds: [a2.uuid],
    });

    await ensureParticipant(app.db, chat.id, human.uuid);

    expect(await loadChatType(chat.id)).toBe("group");
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, human.uuid))?.mode).toBe("full");
  });

  it("is idempotent — ensureParticipant for an existing participant does not re-flip modes", async () => {
    // Admin sending multiple messages must not re-run the upgrade on every
    // call. We pin existing members to specific modes and assert they're
    // untouched when a repeat ensureParticipant fires.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `idem-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `idem-a2-${uid}` });
    const { agent: a3 } = await createTestAgent(app, { name: `idem-a3-${uid}` });

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "group",
      participantIds: [a2.uuid, a3.uuid],
    });
    // Pin a1 to a distinct mode so any inadvertent re-upgrade is visible.
    await app.db
      .update(chatMembership)
      .set({ mode: "full" })
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, a1.agent.uuid)));

    await ensureParticipant(app.db, chat.id, a1.agent.uuid);

    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("full");
  });
});
