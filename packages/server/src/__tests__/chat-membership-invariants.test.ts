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
 *
 *   4. Engagement state on `chat_user_state` survives every membership
 *      mutation. These three cases are the structural regression tests for
 *      the pain points (#2 state-carry across migration, #3 silent-overwrite
 *      from recompute) that closed PR #316 — the new data model is supposed
 *      to make them physically impossible. If one of these tests fails, the
 *      invariant has regressed.
 */

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, joinMeChat, leaveMeChat, markMeChatRead, setChatEngagement } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { addChatParticipants } from "../services/participant-mode.js";
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
      source: "api",
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

  it("detach → re-add round-trip revives chat_user_state (read state survives the full cycle)", async () => {
    // §11.4 says read state is "remembered if the user is ever re-added".
    // The preserve-on-detach test above only covers the first half. This
    // test pins the full round-trip: speaker → DELETE chat_membership →
    // re-INSERT chat_membership → chat_user_state row still carries the
    // pre-detach last_read_at / unread_mention_count.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-revive" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Seed an unread mention so chat_user_state has a non-trivial payload
    // to survive the round-trip. Direct seed avoids the mention-pipeline
    // dependency on `agents.name` (createTestAdmin doesn't expose it).
    await app.db.execute(sql`
      INSERT INTO chat_user_state (chat_id, agent_id, last_read_at, unread_mention_count)
      VALUES (${chatId}, ${admin.humanAgentUuid}, now() - interval '1 hour', 3)
      ON CONFLICT (chat_id, agent_id) DO UPDATE
        SET last_read_at = EXCLUDED.last_read_at,
            unread_mention_count = EXCLUDED.unread_mention_count
    `);
    const [pre] = await app.db
      .select({ lastReadAt: chatUserState.lastReadAt, unread: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(pre?.unread).toBe(3);

    // Full detach (admin manages nobody in this chat).
    const leaveResult = await leaveMeChat(app.db, chatId, admin.humanAgentUuid);
    expect(leaveResult.membershipKind).toBeNull();
    const [membershipAfterLeave] = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(membershipAfterLeave).toBeUndefined();

    // Re-add admin as a speaker via the canonical entry point. addChatParticipants
    // UPSERTs chat_membership but does NOT touch chat_user_state — the read
    // state is structurally separate (§8 design intent).
    await addChatParticipants(app.db, chatId, [{ agentId: admin.humanAgentUuid, role: "member" }]);

    // chat_membership is back as speaker …
    const [membershipAfterRejoin] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(membershipAfterRejoin?.accessMode).toBe("speaker");

    // … and the read state is byte-for-byte identical to pre-detach.
    const [post] = await app.db
      .select({ lastReadAt: chatUserState.lastReadAt, unread: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)));
    expect(post?.lastReadAt?.getTime()).toBe(pre?.lastReadAt?.getTime());
    expect(post?.unread).toBe(pre?.unread);
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

  it("speaker → watcher downgrade preserves mode and source (only access_mode flips)", async () => {
    // Concern from review on PR #325: `leaveAsParticipant`'s downgrade
    // path historically reset `mode='full'` and `source='auto_manager'`,
    // silently throwing away the row's original metadata. The fix is to
    // flip ONLY `access_mode`; this test pins that contract so future
    // refactors don't reintroduce the reset.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-mode-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Mode",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-mode" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    await joinMeChat(app.db, chatId, admin.humanAgentUuid);

    // Mutate admin's speaker row to a non-default mode + source so the
    // downgrade has something visible to either preserve or clobber.
    await app.db.execute(sql`
      UPDATE chat_membership
         SET mode = 'mention_only', source = 'manual'
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);

    // Admin leaves → downgrades to watcher (managed is still a speaker, so admin stays as watcher).
    const result = await leaveMeChat(app.db, chatId, admin.humanAgentUuid);
    expect(result.membershipKind).toBe("watching");

    const [after] = await app.db
      .select({ accessMode: chatMembership.accessMode, mode: chatMembership.mode, source: chatMembership.source })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(after?.accessMode).toBe("watcher");
    expect(after?.mode).toBe("mention_only");
    expect(after?.source).toBe("manual");
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

  // ---------------------------------------------------------------------------
  // Engagement-status survival across membership mutations.
  //
  // Closed PR #316 was rejected because the old `chat_participants` +
  // `chat_subscriptions` split forced engagement_status to be carried
  // explicitly across every speaker ↔ watcher transition (and was silently
  // overwritten by `recomputeChatWatchers`). The new data model puts
  // engagement on `chat_user_state` — a different table from
  // `chat_membership` — so every structural mutation leaves it alone by
  // construction. These tests pin that invariant.
  // ---------------------------------------------------------------------------

  it("speaker → watcher transition preserves engagement_status (no state-carry needed)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-eng1-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Eng1",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-eng1" });

    // Admin's human agent starts as a speaker by creating the chat. Archive it.
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid, managed.uuid],
    });
    await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");

    // Leave → admin becomes a watcher (still anchored on `managed`).
    const leaveResult = await leaveMeChat(app.db, chatId, admin.humanAgentUuid);
    expect(leaveResult.membershipKind).toBe("watching");

    // Engagement still archived — the access_mode flip on chat_membership
    // never touched chat_user_state.
    const [row] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(row?.engagement_status).toBe("archived");
  });

  it("recomputeChatWatchers does NOT modify engagement_status (silent-overwrite regression)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-eng2-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-Eng2",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-eng2" });

    // peer creates a chat with `managed`; admin becomes a watcher via
    // recompute (anchored on `managed`).
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    await recomputeChatWatchers(app.db, chatId);

    // Archive as watcher.
    await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");

    // Force several recompute passes (idempotent ops paths).
    await recomputeChatWatchers(app.db, chatId);
    await recomputeChatWatchers(app.db, chatId);
    await recomputeChatWatchers(app.db, chatId);

    // engagement_status survives every pass.
    const [row] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(row?.engagement_status).toBe("archived");
  });

  it("markMeChatRead is orthogonal to engagement_status (per-user state lanes are independent)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-eng3" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");

    // markRead writes to chat_user_state but only updates the read-state
    // columns — engagement_status must not be reset to its INSERT default.
    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);

    const [row] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(row?.engagement_status).toBe("archived");
  });
});
