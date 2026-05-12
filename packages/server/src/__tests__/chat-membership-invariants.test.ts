/**
 * Pin the design-level invariants of the chat_membership / chat_user_state
 * split (proposals/chat-data-model-restructure.20260512.md §8).
 *
 *   1. `recomputeChatWatchers` NEVER modifies `access_mode='speaker'` rows.
 *      A user's explicit join/leave decision must not be overwritten by
 *      ops paths — see §11.5 "silent regression" risk.
 *
 *   2. Detach (`leaveAsParticipant` when no managed agent remains in chat)
 *      preserves the `chat_user_state` row by default — §11.4. Read state
 *      is remembered if the user is ever re-added.
 *
 *   3. `chat_membership` and `chat_user_state` are structurally independent:
 *      `markMeChatRead` writes to `chat_user_state` without touching
 *      `chat_membership.access_mode`.
 */

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, joinMeChat, leaveMeChat, markMeChatRead } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { recomputeChatWatchers } from "../services/watcher.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("chat membership invariants", () => {
  const getApp = useTestApp();

  it("recomputeChatWatchers never modifies existing speaker rows", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-rcw-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Rcw",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-rcw" });

    // Bootstrap a chat where:
    //   - peer is a speaker (created the chat)
    //   - managed is a speaker (added as a participant)
    //   - admin's human agent will become a watcher via recompute (anchored on `managed`)
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // Capture the speaker rows' (mode, source, joined_at) before recompute.
    const beforeSpeakers = await app.db
      .select({
        agentId: chatMembership.agentId,
        mode: chatMembership.mode,
        source: chatMembership.source,
        joinedAt: chatMembership.joinedAt,
      })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
    expect(beforeSpeakers.length).toBe(2);

    // Force a recompute pass; admin's watcher row should be inserted (or
    // confirmed) without touching either speaker row.
    await recomputeChatWatchers(app.db, chatId);
    await recomputeChatWatchers(app.db, chatId); // idempotent

    const afterSpeakers = await app.db
      .select({
        agentId: chatMembership.agentId,
        mode: chatMembership.mode,
        source: chatMembership.source,
        joinedAt: chatMembership.joinedAt,
      })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

    expect(afterSpeakers.length).toBe(2);
    // Per-row byte-for-byte equality on every column recompute could plausibly
    // touch: mode (mention_only for managed in a direct↔non-human chat), source,
    // and joined_at (must not be reset to now()).
    const beforeById = new Map(beforeSpeakers.map((r) => [r.agentId, r]));
    for (const after of afterSpeakers) {
      const before = beforeById.get(after.agentId);
      expect(before).toBeDefined();
      expect(after.mode).toBe(before?.mode);
      expect(after.source).toBe(before?.source);
      expect(after.joinedAt.getTime()).toBe(before?.joinedAt.getTime());
    }

    // Admin's watcher row exists (recompute's positive effect).
    const [watcher] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(watcher?.accessMode).toBe("watcher");
  });

  it("detach (leaveMeChat without remaining managed speaker) preserves chat_user_state row", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-detach" });

    // Admin's human agent creates a direct chat with peer — admin is the
    // sole speaker on their side, no managed agent stays after they leave.
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // peer sends a message so admin has an unread counter to remember.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      format: "text",
      content: "ping",
      metadata: { mentions: [admin.humanAgentUuid] },
    });

    // Materialise the chat_user_state row by marking read.
    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);

    const [stateBefore] = await app.db
      .select({ chatId: chatUserState.chatId, lastReadAt: chatUserState.lastReadAt })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(stateBefore).toBeDefined();
    expect(stateBefore?.lastReadAt).not.toBeNull();

    // Admin leaves; with no managed agent in the chat they fully detach.
    await leaveMeChat(app.db, chatId, admin.humanAgentUuid);

    // chat_membership row is gone…
    const [membership] = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(membership).toBeUndefined();

    // …but chat_user_state row is preserved (§11.4 default).
    const [stateAfter] = await app.db
      .select({ chatId: chatUserState.chatId, lastReadAt: chatUserState.lastReadAt })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(stateAfter).toBeDefined();
    expect(stateAfter?.lastReadAt?.getTime()).toBe(stateBefore?.lastReadAt?.getTime());
  });

  it("markMeChatRead writes chat_user_state without touching chat_membership.access_mode", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-mark-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Mark",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-mark" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    // Admin is currently a watcher (anchored on managed).
    const [before] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(before?.accessMode).toBe("watcher");

    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);

    // After mark-read, admin is still a watcher — access_mode untouched.
    const [after] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(after?.accessMode).toBe("watcher");

    // And chat_user_state.last_read_at is populated.
    const [state] = await app.db
      .select({ lastReadAt: chatUserState.lastReadAt })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(state?.lastReadAt).not.toBeNull();
  });

  it("speaker → watcher (joinMeChat then leaveMeChat) preserves chat_user_state row", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-join-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Join",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-join" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // Materialise read state while still a watcher.
    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);
    const [stateBefore] = await app.db
      .select({ lastReadAt: chatUserState.lastReadAt, unreadMentionCount: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(stateBefore).toBeDefined();

    // watcher → speaker, then speaker → watcher (managed agent is still a speaker so doesn't detach).
    await joinMeChat(app.db, chatId, admin.humanAgentUuid);
    await leaveMeChat(app.db, chatId, admin.humanAgentUuid);

    // access_mode flipped back to 'watcher'…
    const [membership] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(membership?.accessMode).toBe("watcher");

    // …and chat_user_state.last_read_at is byte-identical (proves the read
    // state survived both access_mode transitions untouched).
    const [stateAfter] = await app.db
      .select({ lastReadAt: chatUserState.lastReadAt, unreadMentionCount: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(stateAfter?.lastReadAt?.getTime()).toBe(stateBefore?.lastReadAt?.getTime());
    expect(stateAfter?.unreadMentionCount).toBe(stateBefore?.unreadMentionCount);
  });

  it("recomputeChatWatchers does not leave orphan rows when speakers come and go", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-orph-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Orph",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-orph" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // admin is a watcher.
    const [w1] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(w1?.accessMode).toBe("watcher");

    // Remove the managed agent speaker row directly (simulating leaveChat
    // followed by recompute on a now-stale watcher anchor).
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, managed.uuid)));
    await recomputeChatWatchers(app.db, chatId);

    // Admin's watcher row should be gone — no managed non-human anchor remains.
    const [w2] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(w2).toBeUndefined();

    // peer's speaker row is untouched.
    const peerRow = await app.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM chat_membership WHERE chat_id = ${chatId} AND agent_id = ${peer.agent.uuid} AND access_mode = 'speaker'`,
    );
    expect(peerRow[0]?.count).toBe(1);
  });
});
