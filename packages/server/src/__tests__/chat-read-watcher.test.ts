/**
 * Regression coverage for issue #394 — watcher rows on chat_membership
 * must be able to clear their own unread state via POST /chats/:id/read.
 *
 * Before the fix, `requireChatAccess` only let a "direct speaker" pass on
 * the membership branch. Watchers had to rely on the supervisor branch
 * (`agents.managerId = caller.memberId` for some speaker in the chat).
 * When the supervisor anchor was stale — the managed speaker had left
 * the chat but `recomputeChatWatchers` had not run yet — the watcher
 * row outlived the supervisor link, and mark-read 404'd with no way for
 * the user to dismiss the unread badge surfaced by `listMeChats`.
 *
 * Two scenarios pinned here:
 *   1. Healthy supervisor-watcher — mark-read works (was already fine).
 *   2. Stale watcher (no managed speaker anymore) — mark-read works
 *      after the fix; was 404 before.
 */

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { recomputeChatWatchers } from "../services/watcher.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("issue #394 — watcher mark-read", () => {
  const getApp = useTestApp();

  it("healthy supervisor-watcher can mark-read", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Mng",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-h" });
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    await recomputeChatWatchers(app.db, chatId);

    await app.db.insert(chatUserState).values({
      chatId,
      agentId: admin.humanAgentUuid,
      unreadMentionCount: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/read`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const [state] = await app.db
      .select({ unread: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)))
      .limit(1);
    expect(state?.unread).toBe(0);
  });

  it("stale watcher (no managed speaker anymore) can still mark-read", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `mng-stale-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Mng-Stale",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createTestAgent(app, { name: "peer-s" });
    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    await recomputeChatWatchers(app.db, chatId);

    // Sever the supervisor anchor: remove the managed speaker without
    // re-running `recomputeChatWatchers`. The admin's watcher row stays,
    // and `listMeChats` still surfaces the chat — the same shape as the
    // production stale-watcher state #394 reports.
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, managed.uuid)));

    const [stillWatcher] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, admin.humanAgentUuid)))
      .limit(1);
    expect(stillWatcher?.accessMode).toBe("watcher");

    await app.db.insert(chatUserState).values({
      chatId,
      agentId: admin.humanAgentUuid,
      unreadMentionCount: 1,
    });

    // Chat still surfaces with unread (red badge would show on the
    // sidebar) — the user needs a way to dismiss it.
    const meChats = (await app.db.execute(sql`
      SELECT COALESCE(cus.unread_mention_count, 0) AS unread
        FROM chats c
        JOIN chat_membership cm ON cm.chat_id = c.id AND cm.agent_id = ${admin.humanAgentUuid}
        LEFT JOIN chat_user_state cus ON cus.chat_id = c.id AND cus.agent_id = ${admin.humanAgentUuid}
       WHERE c.id = ${chatId}
    `)) as unknown as Array<{ unread: number }>;
    expect(meChats[0]?.unread).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/read`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const [state] = await app.db
      .select({ unread: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, admin.humanAgentUuid)))
      .limit(1);
    expect(state?.unread).toBe(0);
  });
});
