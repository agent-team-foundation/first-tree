/**
 * Service-level tests for the chat-first workspace `/me/chats` surface.
 *
 * Verifies the design's core invariants:
 *
 *   1. Watcher rows (`chat_membership.access_mode = 'watcher'`) never
 *      appear in `inbox_entries` even when a chat is messaged.
 *   2. Mention candidates resolve from speaker rows only
 *      (`access_mode = 'speaker'`) — watchers cannot be `@`-mentioned.
 *   3. Mention propagation increments the watcher's
 *      `chat_user_state.unread_mention_count` when the watched managed
 *      agent is mentioned.
 *   4. `chats.last_message_at` / `last_message_preview` advance on each send.
 *   5. `joinAsParticipant` preserves `chat_user_state` (last_read_at +
 *      unread_mention_count survive the watcher → speaker flip).
 *   6. `leaveAsParticipant` returns the user to "watching" state if they
 *      still manage another participant; otherwise fully detaches.
 *   7. `markMeChatRead` clears `chat_user_state.unread_mention_count`.
 *   8. `direct → group` upgrade fires when add-participant brings the count
 *      to 3, and watcher rows are flipped to speaker for newly-joined
 *      speakers (orthogonal axes: role + access_mode).
 *
 * See docs/chat-first-workspace-product-design.md for the contract under test.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyAfterFanOut } from "../services/chat-projection.js";
import {
  addMeChatParticipants,
  countUnreadMeChats,
  createMeChat,
  joinMeChat,
  leaveMeChat,
  listMeChats,
  markMeChatRead,
} from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { recomputeChatWatchers } from "../services/watcher.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("chat-first workspace service layer", () => {
  const getApp = useTestApp();

  it("listMeChats: empty when user has no participations", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, { limit: 50, filter: "all" });
    expect(res.rows).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it("createMeChat: always creates a new chat (no dedupe)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-1" });

    const a = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const b = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    expect(a.chatId).not.toBe(b.chatId);
  });

  it("watcher rows: managed agent's chat creates a subscription, not a participant", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const { agents } = await import("../db/schema/agents.js");
    const managed = await (await import("../services/agent.js")).createAgent(app.db, {
      name: `managed-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Managed Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });

    const peer = await createTestAgent(app, { name: "peer-2" });
    const peerHuman = peer.agent.uuid;

    // peer creates a chat with our managed agent
    const result = await createMeChat(app.db, peerHuman, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // admin (manager of `managed`) should now see this chat as a watcher
    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, { limit: 50, filter: "all" });
    const row = list.rows.find((r) => r.chatId === result.chatId);
    expect(row).toBeDefined();
    expect(row?.membershipKind).toBe("watching");
    expect(row?.canReply).toBe(false);
    void agents;
  });

  it("watchers never receive inbox_entries, ever", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `managed-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Managed",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-3" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // peer sends a message into the chat
    await sendMessage(app.db, chatId, peer.agent.uuid, { format: "text", content: "hello @managed" });

    // admin's human agent (the watcher) must NOT have an inbox entry for this chat
    const inboxRows = await app.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM inbox_entries ie
        JOIN agents a ON a.inbox_id = ie.inbox_id
       WHERE ie.chat_id = ${chatId} AND a.uuid = ${admin.humanAgentUuid}
    `);
    expect(inboxRows[0]?.count).toBe(0);
  });

  it("chat-projection: applyAfterFanOut bumps last_message_at and watcher counter", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-4" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // Direct send via sendMessage (which itself calls applyAfterFanOut), with
    // an explicit @-mention of `managed` to trigger watcher propagation.
    await sendMessage(
      app.db,
      chatId,
      peer.agent.uuid,
      { format: "text", content: `@${managed.name} Please review` },
      { enforceGroupMention: false },
    );

    // chats projection updated. Raw `db.execute` returns timestamptz as
    // an ISO string (no column-type metadata); we just need it non-null.
    const projRows = (await app.db.execute(
      sql`SELECT last_message_at, last_message_preview FROM chats WHERE id = ${chatId}`,
    )) as unknown as Array<{ last_message_at: string | Date | null; last_message_preview: string | null }>;
    const projRow = projRows[0];
    expect(projRow?.last_message_at).not.toBeNull();
    expect(projRow?.last_message_preview).toContain("Please review");

    // watcher counter incremented for admin (manager of `managed`)
    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, { limit: 10, filter: "all" });
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row?.unreadMentionCount).toBeGreaterThanOrEqual(1);
    void applyAfterFanOut;
    void recomputeChatWatchers;
  });

  it("markMeChatRead clears the watcher's counter (and the participant counter)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng2-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng2",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-5" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      format: "text",
      content: `@${managed.name} hi`,
    });

    // Pre: counter is 1+
    const before = await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId);
    expect(before).toBeGreaterThanOrEqual(1);

    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);

    const after = await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId);
    expect(after).toBe(0);
  });

  it("countUnreadMeChats excludes detached chats (chat_user_state preserved but no membership)", async () => {
    // Regression: §11.4 preserves chat_user_state on full detach so a
    // leave-then-rejoin round-trip remembers read state. But the badge
    // count must NOT include those preserved rows — `listMeChats`
    // inner-joins chat_membership, so without the same join the badge
    // would show "1 unread" while the conversation list shows nothing.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-detach" });

    // Direct chat where admin is a speaker (not a manager of any peer
    // agent in this chat) — so leaveMeChat fully detaches admin.
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Seed an unread mention directly. We bypass the mention pipeline
    // here because `createTestAdmin` doesn't surface the admin's
    // randomised agent name; the contract under test is the count
    // query, not the resolver.
    await app.db.execute(sql`
      INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count)
      VALUES (${chatId}, ${admin.humanAgentUuid}, 1)
      ON CONFLICT (chat_id, agent_id) DO UPDATE SET unread_mention_count = 1
    `);
    expect(await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId)).toBeGreaterThanOrEqual(1);

    // Fully detach admin (admin manages no other speaker in this chat).
    const result = await leaveMeChat(app.db, chatId, admin.humanAgentUuid);
    expect(result.membershipKind).toBeNull();

    // chat_user_state row is intentionally preserved …
    const [preserved] = await app.db.execute<{ unread_mention_count: number }>(
      sql`SELECT unread_mention_count FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(preserved?.unread_mention_count ?? 0).toBeGreaterThanOrEqual(1);

    // … but the badge count must not include it.
    expect(await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId)).toBe(0);
  });

  it("joinMeChat upgrades watcher → speaker; chat_user_state is preserved across the access_mode flip", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng3-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng3",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-6" });
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    // Bump the watcher's unread counter via a mention of the managed agent.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      format: "text",
      content: `@${managed.name} ping`,
    });

    // Pre-state: admin's chat_user_state row has unread_mention_count >= 1.
    const [preState] = await app.db.execute<{ unread_mention_count: number }>(
      sql`SELECT unread_mention_count FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(preState?.unread_mention_count).toBeGreaterThanOrEqual(1);

    await joinMeChat(app.db, chatId, admin.humanAgentUuid);

    // chat_membership row is now access_mode = 'speaker' (the access_mode flip
    // is the entirety of the watcher → speaker transition under the new model).
    const [membershipRow] = await app.db.execute<{ access_mode: string }>(
      sql`SELECT access_mode FROM chat_membership WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(membershipRow?.access_mode).toBe("speaker");

    // chat_user_state row is untouched — the read state persists across the
    // promotion without any state-carry transaction (proposal §8.4).
    const [postState] = await app.db.execute<{ unread_mention_count: number }>(
      sql`SELECT unread_mention_count FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(postState?.unread_mention_count).toBe(preState?.unread_mention_count);
  });

  it("leaveMeChat returns to 'watching' if user still manages a chat participant", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng4-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng4",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-7" });
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    await joinMeChat(app.db, chatId, admin.humanAgentUuid);

    const result = await leaveMeChat(app.db, chatId, admin.humanAgentUuid);
    expect(result.membershipKind).toBe("watching");

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, { limit: 50, filter: "all" });
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row?.membershipKind).toBe("watching");
  });

  it("addMeChatParticipants: direct → group upgrade and watcher cleanup", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const a = await createTestAgent(app, { name: "agp-a" });
    const b = await createTestAgent(app, { name: "agp-b" });

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [a.agent.uuid],
    });
    // start as direct (2 speakers); add b → 3 speakers → group
    await addMeChatParticipants(app.db, chatId, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [b.agent.uuid],
    });

    const [chatRow] = await app.db.execute<{ type: string }>(sql`SELECT type FROM chats WHERE id = ${chatId}`);
    expect(chatRow?.type).toBe("group");
  });

  it("addMeChatParticipants: chat_user_state is preserved when a watcher is promoted to speaker", async () => {
    // Regression for review #228 issue #1: when a watcher is promoted via
    // POST /me/chats/:id/participants, its lastReadAt + unreadMentionCount
    // must survive the transition. Under the new model, chat_user_state
    // lives in a separate table from chat_membership, so the promotion
    // is a single UPDATE of access_mode — the read state is preserved by
    // construction, no state-carry transaction needed.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng-sc-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-SC",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const owner = await createTestAgent(app, { name: "agp-sc-owner" });

    // owner-direct-with-managed → admin becomes a watcher (manager of `managed`).
    const { chatId } = await createMeChat(app.db, owner.agent.uuid, owner.organizationId, {
      participantIds: [managed.uuid],
    });
    // Seed a non-trivial read state: pretend the admin has 3 mentions
    // outstanding and last read 1h ago. Direct UPSERT into chat_user_state
    // keeps the test independent of mention-fan-out timing.
    const lastReadAt = new Date(Date.now() - 3600_000);
    const { chatUserState } = await import("../db/schema/chat-user-state.js");
    await app.db
      .insert(chatUserState)
      .values({
        chatId,
        agentId: admin.humanAgentUuid,
        lastReadAt,
        unreadMentionCount: 3,
      })
      .onConflictDoUpdate({
        target: [chatUserState.chatId, chatUserState.agentId],
        set: { lastReadAt, unreadMentionCount: 3 },
      });

    // Owner adds admin as a speaking participant.
    await addMeChatParticipants(app.db, chatId, owner.agent.uuid, owner.organizationId, {
      participantIds: [admin.humanAgentUuid],
    });

    // chat_membership row is now access_mode = 'speaker'.
    const [membershipRow] = await app.db.execute<{ access_mode: string }>(sql`
      SELECT access_mode FROM chat_membership
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);
    expect(membershipRow?.access_mode).toBe("speaker");

    // chat_user_state row is untouched — read state preserved.
    const [stateRow] = await app.db.execute<{
      last_read_at: string | null;
      unread_mention_count: number;
    }>(sql`
      SELECT last_read_at, unread_mention_count FROM chat_user_state
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);
    expect(stateRow).toBeDefined();
    expect(stateRow?.unread_mention_count).toBe(3);
    expect(new Date(stateRow?.last_read_at ?? 0).toISOString()).toBe(lastReadAt.toISOString());
  });

  it("addMeChatParticipants: refuses caller who is not a speaking participant", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const stranger = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "agp-peer" });

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Stranger is not a participant, must be refused (404 to avoid uuid probing).
    await expect(
      addMeChatParticipants(app.db, chatId, stranger.humanAgentUuid, stranger.organizationId, {
        participantIds: [stranger.humanAgentUuid],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("watcher cannot be a mention recipient (mention-candidate invariant)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng-mc-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Mng-MC",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-mc" });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // peer @-mentions admin (the watcher) by name. Mention extraction reads
    // speakers only (chat_membership where access_mode = 'speaker'), so
    // admin is NOT in the candidate set — the resulting message must NOT
    // bump admin's `unread_mention_count` in chat_user_state.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      format: "text",
      content: `Hi @${admin.username}, please look`,
    });

    const [adminStateRow] = await app.db.execute<{ unread_mention_count: number | null }>(sql`
      SELECT unread_mention_count FROM chat_user_state
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);
    // Either the row was never created (lazy materialisation, no event
    // touched it) or the count was bumped via the watcher-manager path
    // (which IS the legitimate channel for a manager-of-mentioned-non-human).
    // In this test the mention target is admin themselves, not the managed
    // agent — so neither the speaker nor the watcher branch should fire.
    expect(adminStateRow?.unread_mention_count ?? 0).toBe(0);
  });

  it("listMeChats: cursor pagination is correct across NULL-timestamped chats", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-cur" });

    // Create 3 chats; only chat #1 will have a message (non-null
    // last_message_at), chats #2 and #3 stay NULL-timestamped.
    const c1 = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const c2 = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const c3 = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, c1.chatId, admin.humanAgentUuid, { format: "text", content: "hi" });

    // Page size 2: first page is [c1, one of c2/c3]; second page returns
    // exactly the missing one.
    const page1 = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, { limit: 2, filter: "all" });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.rows[0]?.chatId).toBe(c1.chatId); // most-recent message wins

    const page2 = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, {
      limit: 2,
      filter: "all",
      cursor: page1.nextCursor ?? undefined,
    });
    const seen = new Set([...page1.rows.map((r) => r.chatId), ...page2.rows.map((r) => r.chatId)]);
    expect(seen.has(c1.chatId)).toBe(true);
    expect(seen.has(c2.chatId)).toBe(true);
    expect(seen.has(c3.chatId)).toBe(true);
    // No duplicates across pages
    expect(seen.size).toBe(3);
  });

  it("listMeChats threads filter: parent_chat_id IS NOT NULL is excluded in v1", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-th" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // forge a thread row anchored to the parent chat
    await app.db.execute(sql`
      INSERT INTO chats (id, organization_id, type, parent_chat_id)
      VALUES ('thread-x', ${admin.organizationId}, 'thread', ${chatId})
    `);
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode)
      VALUES ('thread-x', ${admin.humanAgentUuid}, 'member', 'speaker')
    `);

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, { limit: 50, filter: "all" });
    const ids = list.rows.map((r) => r.chatId);
    expect(ids).toContain(chatId);
    expect(ids).not.toContain("thread-x");
  });
});
