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
 * See first-tree-context:agent-hub/web-console.md for the contract under test.
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
  markMeChatUnread,
  setChatEngagement,
} from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { recomputeChatWatchers } from "../services/watcher.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("chat-first workspace service layer", () => {
  const getApp = useTestApp();

  it("listMeChats: empty when user has no participations", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
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
      type: "agent",
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
    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
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
      type: "agent",
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
    await sendMessage(app.db, chatId, peer.agent.uuid, { source: "api", format: "text", content: "hello @managed" });

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
      type: "agent",
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
    // an explicit mention of `managed` to trigger watcher propagation.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${managed.name} Please review`,
      metadata: { mentions: [managed.uuid] },
    });

    // chats projection updated. Raw `db.execute` returns timestamptz as
    // an ISO string (no column-type metadata); we just need it non-null.
    const projRows = (await app.db.execute(
      sql`SELECT last_message_at, last_message_preview FROM chats WHERE id = ${chatId}`,
    )) as unknown as Array<{ last_message_at: string | Date | null; last_message_preview: string | null }>;
    const projRow = projRows[0];
    expect(projRow?.last_message_at).not.toBeNull();
    expect(projRow?.last_message_preview).toContain("Please review");

    // watcher counter incremented for admin (manager of `managed`)
    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 10,
      filter: "all",
      engagement: "all",
    });
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
      type: "agent",
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
      source: "api",
      format: "text",
      content: `@${managed.name} hi`,
      metadata: { mentions: [managed.uuid] },
    });

    // Pre: counter is 1+
    const before = await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId);
    expect(before).toBeGreaterThanOrEqual(1);

    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);

    const after = await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId);
    expect(after).toBe(0);
  });

  it("markMeChatUnread bumps a read chat back to unread without touching last_read_at", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-mark-unread" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Establish a non-null `last_read_at` first so we can assert it isn't
    // rewound by markMeChatUnread.
    await markMeChatRead(app.db, chatId, admin.humanAgentUuid);
    const [beforeRow] = await app.db.execute<{ last_read_at: string | null; unread_mention_count: number }>(
      sql`SELECT last_read_at, unread_mention_count FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(beforeRow?.unread_mention_count).toBe(0);
    expect(beforeRow?.last_read_at).not.toBeNull();
    const lastReadAtBefore = beforeRow?.last_read_at;

    const res = await markMeChatUnread(app.db, chatId, admin.humanAgentUuid);
    expect(res).toEqual({ chatId, unreadMentionCount: 1 });

    const [afterRow] = await app.db.execute<{ last_read_at: string | null; unread_mention_count: number }>(
      sql`SELECT last_read_at, unread_mention_count FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(afterRow?.unread_mention_count).toBe(1);
    // `last_read_at` is intentionally not modified — this is a UI affordance,
    // not a read-cursor rewind.
    expect(afterRow?.last_read_at).toEqual(lastReadAtBefore);
    expect(await countUnreadMeChats(app.db, admin.humanAgentUuid, admin.organizationId)).toBe(1);
  });

  it("markMeChatUnread is idempotent and never reduces a pre-existing higher count", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-mark-unread-idem" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Seed `unread_mention_count = 3` to mimic accumulated mentions.
    await app.db.execute(sql`
      INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count)
      VALUES (${chatId}, ${admin.humanAgentUuid}, 3)
      ON CONFLICT (chat_id, agent_id) DO UPDATE SET unread_mention_count = 3
    `);

    // First call: GREATEST(3, 1) keeps it at 3.
    const r1 = await markMeChatUnread(app.db, chatId, admin.humanAgentUuid);
    expect(r1.unreadMentionCount).toBe(3);

    // Second call: still 3.
    const r2 = await markMeChatUnread(app.db, chatId, admin.humanAgentUuid);
    expect(r2.unreadMentionCount).toBe(3);
  });

  it("markMeChatUnread lazily materialises a chat_user_state row when none exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-mark-unread-lazy" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // createMeChat doesn't materialise chat_user_state for the creator; ensure
    // the row really is absent so we exercise the INSERT branch.
    await app.db.execute(
      sql`DELETE FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );

    const res = await markMeChatUnread(app.db, chatId, admin.humanAgentUuid);
    expect(res).toEqual({ chatId, unreadMentionCount: 1 });

    const [row] = await app.db.execute<{ unread_mention_count: number; last_read_at: string | null }>(
      sql`SELECT unread_mention_count, last_read_at FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(row?.unread_mention_count).toBe(1);
    expect(row?.last_read_at).toBeNull();
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
      type: "agent",
      displayName: "Mng3",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-6" });
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    // Bump the watcher's unread counter via an explicit mention of the
    // managed agent.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${managed.name} ping`,
      metadata: { mentions: [managed.uuid] },
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
      type: "agent",
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

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
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
      type: "agent",
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
    // The invariant under test: an `@<watcher-name>` token must not bump
    // the watcher's `unread_mention_count` — mention extraction reads only
    // chat_membership.access_mode = 'speaker', so a watcher's name resolves
    // to nothing even when typed verbatim. We pin this in a group chat
    // (≥3 speakers) so the direct-chat auto-mention path is not exercised
    // here; admin watches no one in this chat, so the manager-of-mentioned
    // branch can't fire either, isolating the name-resolution invariant.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `peer-mc-${crypto.randomUUID().slice(0, 6)}` });
    const peer2 = await createTestAgent(app, { name: `peer2-mc-${crypto.randomUUID().slice(0, 6)}` });
    const peer3 = await createTestAgent(app, { name: `peer3-mc-${crypto.randomUUID().slice(0, 6)}` });

    // Add a watcher row for admin against this chat via raw INSERT — admin
    // doesn't manage any participant, so the standard auto-watcher path
    // doesn't apply, but the invariant we're pinning is about name
    // resolution, not how the watcher row got there.
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [peer2.agent.uuid, peer3.agent.uuid],
    });
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source)
      VALUES (${chatId}, ${admin.humanAgentUuid}, 'member', 'watcher', 'full', 'manual')
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);

    // peer @-mentions admin (the watcher) by name. Mention extraction reads
    // speakers only, so admin is NOT in the candidate set — the resulting
    // message must NOT bump admin's `unread_mention_count`.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: `Hi @${admin.username}, please look`,
    });

    const [adminStateRow] = await app.db.execute<{ unread_mention_count: number | null }>(sql`
      SELECT unread_mention_count FROM chat_user_state
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);
    // Either the row was never created (lazy materialisation, no event
    // touched it) or its count stayed at zero — the @-name path cannot
    // reach a watcher, by design.
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
    await sendMessage(app.db, c1.chatId, admin.humanAgentUuid, { source: "api", format: "text", content: "hi" });

    // Page size 2: first page is [c1, one of c2/c3]; second page returns
    // exactly the missing one.
    const page1 = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 2,
      filter: "all",
      engagement: "all",
    });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.rows[0]?.chatId).toBe(c1.chatId); // most-recent message wins

    const page2 = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 2,
      filter: "all",
      engagement: "all",
      cursor: page1.nextCursor ?? undefined,
    });
    const seen = new Set([...page1.rows.map((r) => r.chatId), ...page2.rows.map((r) => r.chatId)]);
    expect(seen.has(c1.chatId)).toBe(true);
    expect(seen.has(c2.chatId)).toBe(true);
    expect(seen.has(c3.chatId)).toBe(true);
    // No duplicates across pages
    expect(seen.size).toBe(3);
  });

  it("listMeChats nested-chat filter: parent_chat_id IS NOT NULL is excluded", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "peer-nested" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // Forge a row with non-null `parent_chat_id`. The column is decision-inert
    // scaffolding (see first-tree-context PR #281) — the business layer
    // never writes it, but listMeChats still defensively filters such rows out
    // so any historical forged row stays hidden from the conversation list.
    await app.db.execute(sql`
      INSERT INTO chats (id, organization_id, type, parent_chat_id)
      VALUES ('nested-x', ${admin.organizationId}, 'group', ${chatId})
    `);
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode)
      VALUES ('nested-x', ${admin.humanAgentUuid}, 'member', 'speaker')
    `);

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    const ids = list.rows.map((r) => r.chatId);
    expect(ids).toContain(chatId);
    expect(ids).not.toContain("nested-x");
  });

  // ---------------------------------------------------------------------------
  // Engagement-status view filtering, auto-revive, lazy default
  // ---------------------------------------------------------------------------

  it("listMeChats default 'active' view hides archived and deleted rows", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-svc-1" });

    const stays = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const hides = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const gone = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setChatEngagement(app.db, hides.chatId, admin.humanAgentUuid, "archived");
    await setChatEngagement(app.db, gone.chatId, admin.humanAgentUuid, "deleted");

    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "active",
    });
    const ids = res.rows.map((r) => r.chatId);
    expect(ids).toContain(stays.chatId);
    expect(ids).not.toContain(hides.chatId);
    expect(ids).not.toContain(gone.chatId);
  });

  it("listMeChats ?engagement=archived shows only archived rows", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-svc-2" });

    const active = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const archived = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setChatEngagement(app.db, archived.chatId, admin.humanAgentUuid, "archived");

    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "archived",
    });
    const ids = res.rows.map((r) => r.chatId);
    expect(ids).toContain(archived.chatId);
    expect(ids).not.toContain(active.chatId);
  });

  it("listMeChats ?engagement=all unions active+archived but excludes deleted", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-svc-3" });

    const active = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const archived = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const deleted = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setChatEngagement(app.db, archived.chatId, admin.humanAgentUuid, "archived");
    await setChatEngagement(app.db, deleted.chatId, admin.humanAgentUuid, "deleted");

    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    const ids = res.rows.map((r) => r.chatId);
    expect(ids).toContain(active.chatId);
    expect(ids).toContain(archived.chatId);
    expect(ids).not.toContain(deleted.chatId);
  });

  it("new message auto-revives archived → active (applyAfterFanOut)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-svc-4" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");

    await sendMessage(app.db, chatId, peer.agent.uuid, { source: "api", format: "text", content: "ping" });

    const [row] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(row?.engagement_status).toBe("active");
  });

  it("new message does NOT revive deleted rows (deleted is sticky)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-svc-5" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "deleted");

    await sendMessage(app.db, chatId, peer.agent.uuid, { source: "api", format: "text", content: "ping" });

    const [row] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(row?.engagement_status).toBe("deleted");
  });

  it("lazy materialisation: a never-touched chat appears in 'active' view (no chat_user_state row needed)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-svc-6" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // No markRead, no engagement write — chat_user_state row should be absent.
    const stateRows = await app.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
    );
    expect(stateRows[0]?.count).toBe(0);

    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "active",
    });
    expect(res.rows.find((r) => r.chatId === chatId)?.engagementStatus).toBe("active");
  });

  /**
   * Regression for issue 343 — the web picker-source switch (from `/activity`
   * to `/orgs/:orgId/agents`) is only useful if the server's add-participant
   * path also accepts human agents. The service already has no `type` filter,
   * but a regression here would silently undo the picker fix. Lock the
   * invariant: a human added via `addMeChatParticipants` lands as
   * `access_mode = 'speaker'`, identical to adding an AI agent today.
   *
   * `createTestAdmin` lands every member in the shared default org, so the
   * owner + invitee live in the same org without extra wiring.
   */
  it("addMeChatParticipants: accepts a human agent and inserts a speaker row (issue 343)", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const teammate = await createTestAdmin(app);
    expect(teammate.organizationId).toBe(owner.organizationId);

    // Seed a direct chat with one AI agent so owner is a speaker.
    const aiAgent = await createTestAgent(app, { name: "agp-h-ai" });
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [aiAgent.agent.uuid],
    });

    await addMeChatParticipants(app.db, chatId, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [teammate.humanAgentUuid],
    });

    // Raw SQL: `access_mode` isn't surfaced by any service-level read path
    // (listMeChats etc. project it as `membershipKind`, not the raw column).
    // Going to the table directly is the cleanest way to assert what the
    // writer produced.
    const rows = await app.db.execute<{ access_mode: string }>(
      sql`SELECT access_mode FROM chat_membership WHERE chat_id = ${chatId} AND agent_id = ${teammate.humanAgentUuid}`,
    );
    expect(rows[0]?.access_mode).toBe("speaker");
  });
});
