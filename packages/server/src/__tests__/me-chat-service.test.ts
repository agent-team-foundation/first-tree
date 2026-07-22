/**
 * Service-level tests for the chat-first workspace `/me/chats` surface.
 *
 * Verifies the design's core invariants:
 *
 *   1. Watcher rows (`chat_membership.access_mode = 'watcher'`) never
 *      appear in `inbox_entries` even when a chat is messaged.
 *   2. Mention candidates resolve from speaker rows only
 *      (`access_mode = 'speaker'`) — watchers cannot be `@`-mentioned.
 *   3. Mention propagation increments `chat_user_state.unread_mention_count`
 *      ONLY for a directly-mentioned human speaker. Mentioning a watched
 *      managed (non-human) agent wakes it but does NOT bump its
 *      manager-watcher's count — red dots are a direct-human signal. (The
 *      watcher count still bumps via an `agent-final-text` send by the
 *      managed agent; that path is unchanged.)
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

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../db/schema/users.js";
import { listActiveRuntimeChatIds } from "../services/chat.js";
import { applyAfterFanOut } from "../services/chat-projection.js";
import {
  addMeChatParticipants,
  countUnreadMeChats,
  createMeChat,
  getCallerEngagement,
  joinMeChat,
  leaveMeChat,
  listMeChats,
  markMeChatRead,
  markMeChatUnread,
  setChatEngagement,
} from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { recomputeChatWatchers } from "../services/watcher.js";
import { createTestAdmin, createTestAgent, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

describe("chat-first workspace service layer", () => {
  const getApp = useTestApp();

  it("listMeChats: empty when user has no participations", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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

  it("createMeChat rejects self-only participant lists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await expect(
      createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [admin.humanAgentUuid, admin.humanAgentUuid],
      }),
    ).rejects.toThrow(/non-self participant/i);
  });

  it("listMeChats: resolves human external avatars while leaving agent avatars null without an upload", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const teammate = await createTestAdmin(app);
    const bot = await createTestAgent(app, { name: "avatar-list-bot", displayName: "Avatar List Bot" });
    const teammateAvatar = "https://avatars.githubusercontent.com/u/12345?v=4";
    await app.db.update(users).set({ avatarUrl: teammateAvatar }).where(eq(users.id, teammate.userId));

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [teammate.humanAgentUuid, bot.agent.uuid],
    });

    const list = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row).toBeDefined();
    const participantsById = new Map((row?.participants ?? []).map((p) => [p.agentId, p]));

    expect(participantsById.get(teammate.humanAgentUuid)?.avatarImageUrl).toBe(teammateAvatar);
    expect(participantsById.get(bot.agent.uuid)?.avatarImageUrl).toBeNull();
  });

  it("listMeChats: reuses speaker participants for participantCount", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peerA = await createTestAgent(app, { name: "participant-count-a" });
    const peerB = await createTestAgent(app, { name: "participant-count-b" });

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const list = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row?.participants.map((p) => p.agentId).sort()).toEqual(
      [owner.humanAgentUuid, peerA.agent.uuid, peerB.agent.uuid].sort(),
    );
    expect(row?.participantCount).toBe(row?.participants.length);
  });

  it("listMeChats filters by participant and treats empty participant ids as no filter", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peerA = await createTestAgent(app, { name: `with-peer-a-${crypto.randomUUID().slice(0, 6)}` });
    const peerB = await createTestAgent(app, { name: `with-peer-b-${crypto.randomUUID().slice(0, 6)}` });

    const chatA = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peerA.agent.uuid],
    });
    const chatB = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peerB.agent.uuid],
    });

    const peerAOnly = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
        with: [peerA.agent.uuid, peerA.agent.uuid],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(peerAOnly.rows.map((r) => r.chatId)).toEqual([chatA.chatId]);

    const blankFilter = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
        with: [""],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(blankFilter.rows.map((r) => r.chatId).sort()).toEqual([chatA.chatId, chatB.chatId].sort());
  });

  it("listMeChats: only reports explicit mention attention while the mention is unread", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "explicit-mention-peer" });

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // A `request` @-mentions the human, so it drives the explicit-mention
    // attention this test asserts on.
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "request",
      content: "Please look",
      metadata: { mentions: [owner.humanAgentUuid] },
    });

    // The `request` message opens a request to the human, so the chat surfaces
    // in the attention group, not the ordinary `rows` — search all groups.
    const findChat = (res: Awaited<ReturnType<typeof listMeChats>>) =>
      [...res.priorityRows.attention, ...res.priorityRows.pinned, ...res.rows].find((r) => r.chatId === chatId);

    const before = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(findChat(before)).toMatchObject({
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: true,
    });

    await markMeChatRead(app.db, chatId, owner.humanAgentUuid);
    const after = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(findChat(after)).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
    });
  });

  it("listMeChats: keeps topic titles and still falls back to first message when topic is missing", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "title-fallback-peer" });

    const topicChat = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peer.agent.uuid],
      topic: "Pinned topic",
    });
    const untitledChat = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(
      app.db,
      topicChat.chatId,
      owner.humanAgentUuid,
      { source: "api", format: "text", content: "This must not replace the topic" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      untitledChat.chatId,
      owner.humanAgentUuid,
      { source: "api", format: "text", content: "Fallback title from first message" },
      { allowRecipientlessSend: true },
    );

    const list = await listMeChats(
      app.db,
      owner.humanAgentUuid,
      owner.memberId,
      owner.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(list.rows.find((r) => r.chatId === topicChat.chatId)?.title).toBe("Pinned topic");
    expect(list.rows.find((r) => r.chatId === untitledChat.chatId)?.title).toBe("Fallback title from first message");
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
    const list = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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
    await sendMessage(
      app.db,
      chatId,
      peer.agent.uuid,
      { source: "api", format: "text", content: "hello @managed" },
      { allowRecipientlessSend: true },
    );

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

    // The watcher (admin, manager of `managed`) red dot now bumps only via an
    // agent-final-text send by the managed agent — a non-human mention no
    // longer raises a watcher red dot. applyAfterFanOut still runs.
    await sendMessage(app.db, chatId, managed.uuid, {
      source: "api",
      format: "text",
      content: "Please review",
      purpose: "agent-final-text",
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
    const list = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 10,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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
    await sendMessage(app.db, chatId, managed.uuid, {
      source: "api",
      format: "text",
      content: "hi",
      purpose: "agent-final-text",
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
    // Bump the watcher's unread counter via an agent-final-text send by the
    // managed agent (mentioning a managed agent no longer bumps the watcher).
    await sendMessage(app.db, chatId, managed.uuid, {
      source: "api",
      format: "text",
      content: "ping",
      purpose: "agent-final-text",
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

    const list = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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
    // here, isolating the name-resolution invariant: a watcher's name simply
    // does not resolve to a mention candidate.
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
    await sendMessage(
      app.db,
      chatId,
      peer.agent.uuid,
      {
        source: "api",
        format: "text",
        content: `Hi @${admin.username}, please look`,
      },
      { allowRecipientlessSend: true },
    );

    const [adminStateRow] = await app.db.execute<{ unread_mention_count: number | null }>(sql`
      SELECT unread_mention_count FROM chat_user_state
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);
    // Either the row was never created (lazy materialisation, no event
    // touched it) or its count stayed at zero — the @-name path cannot
    // reach a watcher, by design.
    expect(adminStateRow?.unread_mention_count ?? 0).toBe(0);
  });

  it("mentioning a managed non-human agent does NOT bump its manager-watcher's red dot", async () => {
    // Negative regression for the removed watcher-of-mentioned-agent branch.
    // A human (admin) manages `managed`; another participant @-mentions
    // `managed`. The managed agent is woken, but red dots are a direct-human
    // signal, so admin's manager-watcher `unread_mention_count` stays 0.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mng-neg-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "MngNeg",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: `peer-neg-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    // peer @-mentions the managed agent (which is a speaker of this chat).
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${managed.name} please review`,
      metadata: { mentions: [managed.uuid] },
    });

    // admin (manager-watcher of `managed`) gets NO red dot.
    const [adminStateRow] = await app.db.execute<{ unread_mention_count: number | null }>(sql`
      SELECT unread_mention_count FROM chat_user_state
       WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}
    `);
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
    await sendMessage(
      app.db,
      c1.chatId,
      admin.humanAgentUuid,
      { source: "api", format: "text", content: "hi" },
      { allowRecipientlessSend: true },
    );

    // Page size 2: first page is [c1, one of c2/c3]; second page returns
    // exactly the missing one.
    const page1 = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 2,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.rows[0]?.chatId).toBe(c1.chatId); // most-recent message wins

    const page2 = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 2,
        filter: "all",
        engagement: "all",
        cursor: page1.nextCursor ?? undefined,
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    const seen = new Set([...page1.rows.map((r) => r.chatId), ...page2.rows.map((r) => r.chatId)]);
    expect(seen.has(c1.chatId)).toBe(true);
    expect(seen.has(c2.chatId)).toBe(true);
    expect(seen.has(c3.chatId)).toBe(true);
    // No duplicates across pages
    expect(seen.size).toBe(3);
  });

  it("listMeChats: cursor pagination advances across timestamped chats", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `peer-ts-cur-${crypto.randomUUID().slice(0, 6)}` });

    const c1 = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const c2 = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(
      app.db,
      c1.chatId,
      admin.humanAgentUuid,
      { source: "api", format: "text", content: "older timestamped chat" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      c2.chatId,
      admin.humanAgentUuid,
      { source: "api", format: "text", content: "newer timestamped chat" },
      { allowRecipientlessSend: true },
    );

    const page1 = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 1,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.rows[0]?.chatId).toBe(c2.chatId);

    const page2 = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 1,
        filter: "all",
        engagement: "all",
        cursor: page1.nextCursor ?? undefined,
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(page2.rows[0]?.chatId).toBe(c1.chatId);
  });

  it("listMeChats recovers a legacy cursor as a first-page request but 400s an invalid one", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // A recognized pre-PR legacy cursor restarts from page 1 so an already-open
    // client recovers across the rollout instead of looping its load-more Retry.
    // Use the deployed null-tail shape `|<chatId>` (empty timestamp) the old
    // encoder emitted for a `last_message_at IS NULL` boundary.
    const legacy = Buffer.from("|old-chat", "utf8").toString("base64url");
    const recovered = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
        cursor: legacy,
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(recovered.priorityRows).toEqual({ attention: [], pinned: [] });
    expect(Array.isArray(recovered.rows)).toBe(true);

    // A genuinely invalid cursor (here: an unsupported version) still surfaces as
    // a typed 400 so a real client/API bug is not masked as a first-page request.
    const invalid = Buffer.from("v9|2026-05-06T10:24:00.000Z|chat", "utf8").toString("base64url");
    await expect(
      listMeChats(
        app.db,
        admin.humanAgentUuid,
        admin.memberId,
        admin.organizationId,
        {
          limit: 50,
          filter: "all",
          engagement: "all",
          cursor: invalid,
        },
        TEST_AVATAR_AUTHORITY_TAG,
      ),
    ).rejects.toThrow(/invalid cursor/i);
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

    const list = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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

    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    const ids = res.rows.map((r) => r.chatId);
    expect(ids).toContain(stays.chatId);
    expect(ids).not.toContain(hides.chatId);
    expect(ids).not.toContain(gone.chatId);
  });

  it("listActiveRuntimeChatIds returns the runtime agent's non-archived chats for the current human scope", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: "active-runtime-set" });

    const active = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    const archived = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    const deleted = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    await setChatEngagement(app.db, archived.chatId, runtime.humanAgentUuid, "archived");
    await setChatEngagement(app.db, deleted.chatId, runtime.humanAgentUuid, "deleted");

    const ids = await listActiveRuntimeChatIds(
      app.db,
      runtime.agent.uuid,
      runtime.humanAgentUuid,
      runtime.organizationId,
    );

    expect(ids).toContain(active.chatId);
    expect(ids).not.toContain(archived.chatId);
    expect(ids).not.toContain(deleted.chatId);
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

    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "archived",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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

    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
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

    await sendMessage(
      app.db,
      chatId,
      peer.agent.uuid,
      { source: "api", format: "text", content: "ping" },
      { allowRecipientlessSend: true },
    );

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

    await sendMessage(
      app.db,
      chatId,
      peer.agent.uuid,
      { source: "api", format: "text", content: "ping" },
      { allowRecipientlessSend: true },
    );

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

    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(res.rows.find((r) => r.chatId === chatId)?.engagementStatus).toBe("active");
  });

  it("getCallerEngagement defaults to active and returns persisted engagement", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `eng-read-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    await expect(getCallerEngagement(app.db, chatId, admin.humanAgentUuid)).resolves.toBe("active");
    await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");
    await expect(getCallerEngagement(app.db, chatId, admin.humanAgentUuid)).resolves.toBe("archived");
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

  it("addMeChatParticipants rejects an empty participant list before probing the chat", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const aiAgent = await createTestAgent(app, { name: `agp-empty-ai-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [aiAgent.agent.uuid],
    });

    await expect(
      addMeChatParticipants(app.db, chatId, owner.humanAgentUuid, owner.organizationId, { participantIds: [] }),
    ).rejects.toThrow(/at least one participant/i);
  });
});
