import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { addParticipant, createChat, ensureParticipant } from "../services/chat.js";
import { joinMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Validates `addChatParticipants` invariants under v2:
 *
 *   - `chat_membership.mode` is decision-inert; every speaker row written
 *     through `createChat` / `addParticipant` / `ensureParticipant` /
 *     `joinMeChat` (watcher → speaker upgrade) lands as the constant
 *     `'mention_only'`. There is no longer a chat-type re-grade pass —
 *     `chats.type` is locked to `'group'` (first-tree-context PR #465) and
 *     the v1 size=2→3 `regradeNonHumansToMentionOnly` helper has been
 *     retired. The v1 `joinChat` service / `POST /:chatId/join` route was
 *     also removed; the only "manager joins chat" path today is
 *     `joinMeChat` / `POST /:chatId/workspace-join`.
 *
 * The `describe` label "chat upgrade — direct to group" is kept to
 * preserve git history and downstream test-output greppability, but the
 * tests assert v2 semantics (mention_only across the board, no
 * re-grade). See proposals/hub-chat-message-v2-simplify-mode.20260520.md.
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
      type: "group",
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

  it("keeps the joining human at mention_only when they go watcher → speaker via joinMeChat", async () => {
    // The v2 "manager joins chat" path: `POST /:chatId/workspace-join` →
    // `joinMeChat` → `joinAsParticipant`. The watcher row that gates this
    // path is materialised by `recomputeChatWatchers`, which is now
    // automatically run by `addChatParticipants` — so the admin's
    // human-agent watcher row lands the moment `createChat` finishes.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { agents: agentsTable } = await import("../db/schema/agents.js");

    const a1 = await createTestAgent(app, { name: `hup-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `hup-a2-${crypto.randomUUID().slice(0, 6)}` });

    // Force both non-human agents onto the admin so the recompute that runs
    // inside `createChat` pins the admin's human agent as a watcher.
    await app.db.update(agentsTable).set({ managerId: admin.memberId }).where(eq(agentsTable.uuid, a1.agent.uuid));
    await app.db.update(agentsTable).set({ managerId: admin.memberId }).where(eq(agentsTable.uuid, a2.uuid));

    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });

    await joinMeChat(app.db, chat.id, admin.humanAgentUuid);

    expect(await loadChatType(chat.id)).toBe("group");
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, admin.humanAgentUuid))?.mode).toBe("mention_only");
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
      type: "group",
      participantIds: [a2.uuid],
    });

    await ensureParticipant(app.db, chat.id, human.uuid);

    expect(await loadChatType(chat.id)).toBe("group");
    // v2: all speakers written as the constant `'mention_only'`.
    expect((await loadParticipant(chat.id, a1.agent.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, a2.uuid))?.mode).toBe("mention_only");
    expect((await loadParticipant(chat.id, human.uuid))?.mode).toBe("mention_only");
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
