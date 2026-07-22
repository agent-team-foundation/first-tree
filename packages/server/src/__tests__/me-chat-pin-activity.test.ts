/**
 * Tests for the chat-list data foundation: the per-user pin
 * (`chat_user_state.pinned_at`) and the `chats.activity_at` recency field.
 *
 * Invariants under test:
 *   1. `pinMeChat` pins / unpins the caller's own row, idempotently, and the
 *      pin surfaces on `MeChatRow.pinnedAt`.
 *   2. Pin is private per-user state — one agent's pin never touches another
 *      agent's row for the same chat.
 *   3. `activity_at` is initialised at creation, advances on a new message and
 *      on a genuine description change, but NOT on a topic rename or a pin.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { updateChatMetadata } from "../services/chat.js";
import { applyAfterFanOut } from "../services/chat-projection.js";
import { createMeChat, listMeChats, pinMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

describe("pinMeChat + chats.activity_at", () => {
  const getApp = useTestApp();
  type App = ReturnType<typeof getApp>;
  type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

  async function makeChat(app: App): Promise<{ admin: Admin; peerAgentUuid: string; chatId: string }> {
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    return { admin, peerAgentUuid: peer.agent.uuid, chatId };
  }

  async function rowFor(app: App, chatId: string, admin: Admin) {
    const { priorityRows, rows } = await listMeChats(
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
    // A chat can surface in any group now (attention > pinned > ordinary rows) —
    // a pinned chat lives in `priorityRows.pinned`, so search all three.
    return [...priorityRows.attention, ...priorityRows.pinned, ...rows].find((r) => r.chatId === chatId) ?? null;
  }

  async function activityAtOf(app: App, chatId: string): Promise<Date | null> {
    const [row] = await app.db
      .select({ activityAt: chats.activityAt })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    return row?.activityAt ?? null;
  }

  async function pinnedAtOf(app: App, chatId: string, agentId: string): Promise<Date | null> {
    const [row] = await app.db
      .select({ pinnedAt: chatUserState.pinnedAt })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agentId)))
      .limit(1);
    return row?.pinnedAt ?? null;
  }

  it("pins then unpins the caller's row idempotently and surfaces pinnedAt", async () => {
    const app = getApp();
    const { admin, chatId } = await makeChat(app);

    expect((await rowFor(app, chatId, admin))?.pinnedAt).toBeNull();

    const pinned = await pinMeChat(app.db, chatId, admin.humanAgentUuid, true);
    expect(pinned.pinnedAt).not.toBeNull();
    const pinnedRow = await rowFor(app, chatId, admin);
    expect(pinnedRow?.pinnedAt).not.toBeNull();
    expect(new Date(pinnedRow?.pinnedAt ?? 0).getTime()).toBe(new Date(pinned.pinnedAt ?? 0).getTime());

    // Idempotent on the timestamp too: re-pinning keeps a single row AND the
    // original pinned_at anchor (a retry / double-click must not reorder the
    // chat, since pinned_at is the within-group sort key). The intervening DB
    // round-trips guarantee a later wall-clock, so an overwrite would differ.
    const repinned = await pinMeChat(app.db, chatId, admin.humanAgentUuid, true);
    expect(new Date(repinned.pinnedAt ?? 0).getTime()).toBe(new Date(pinned.pinnedAt ?? 0).getTime());
    const callerRows = (await app.db.select().from(chatUserState).where(eq(chatUserState.chatId, chatId))).filter(
      (r) => r.agentId === admin.humanAgentUuid,
    );
    expect(callerRows).toHaveLength(1);

    const unpinned = await pinMeChat(app.db, chatId, admin.humanAgentUuid, false);
    expect(unpinned.pinnedAt).toBeNull();
    expect((await rowFor(app, chatId, admin))?.pinnedAt).toBeNull();
  });

  it("is user-isolated: one agent's pin never touches another agent's row", async () => {
    const app = getApp();
    const { admin, peerAgentUuid, chatId } = await makeChat(app);

    await pinMeChat(app.db, chatId, admin.humanAgentUuid, true);
    // A different agent writing their own (unpinned) row must not affect the caller's pin.
    await pinMeChat(app.db, chatId, peerAgentUuid, false);

    expect(await pinnedAtOf(app, chatId, admin.humanAgentUuid)).not.toBeNull();
    expect(await pinnedAtOf(app, chatId, peerAgentUuid)).toBeNull();
  });

  it("activity_at is initialised at creation, bumped by a message, and not by a pin", async () => {
    const app = getApp();
    const { admin, chatId } = await makeChat(app);

    const created = await activityAtOf(app, chatId);
    expect(created).not.toBeNull();

    // A new message advances activity_at to the message time and surfaces it.
    const msgAt = new Date(Date.now() + 60_000);
    await applyAfterFanOut(app.db, {
      chatId,
      messageId: crypto.randomUUID(),
      senderId: admin.humanAgentUuid,
      mentionedAgentIds: [],
      contentPreview: "hello",
      messageCreatedAt: msgAt,
      bumpForAgentFinalText: false,
    });
    expect((await activityAtOf(app, chatId))?.getTime()).toBe(msgAt.getTime());
    expect(new Date((await rowFor(app, chatId, admin))?.activityAt ?? 0).getTime()).toBe(msgAt.getTime());

    // A pin is not work — it must not move activity_at.
    const before = await activityAtOf(app, chatId);
    await pinMeChat(app.db, chatId, admin.humanAgentUuid, true);
    expect((await activityAtOf(app, chatId))?.getTime()).toBe(before?.getTime());
  });

  it("activity_at is monotonic: an older qualifying event committing last cannot move it backwards", async () => {
    const app = getApp();
    const { admin, chatId } = await makeChat(app);

    const newer = new Date(Date.now() + 120_000);
    const older = new Date(Date.now() + 60_000);

    const send = (contentPreview: string, at: Date) =>
      applyAfterFanOut(app.db, {
        chatId,
        messageId: crypto.randomUUID(),
        senderId: admin.humanAgentUuid,
        mentionedAgentIds: [],
        contentPreview,
        messageCreatedAt: at,
        bumpForAgentFinalText: false,
      });

    // Newer event first sets activity_at to the newer time.
    await send("newer", newer);
    expect((await activityAtOf(app, chatId))?.getTime()).toBe(newer.getTime());

    // An OLDER event reaching the update last must NOT roll activity_at back
    // (GREATEST keeps the newer value).
    await send("older", older);
    expect((await activityAtOf(app, chatId))?.getTime()).toBe(newer.getTime());
  });

  it("activity_at bumps on a real description change but not on a topic rename", async () => {
    const app = getApp();
    const { chatId } = await makeChat(app);
    const before = await activityAtOf(app, chatId);
    expect(before).not.toBeNull();

    // Topic-only rename: no activity bump.
    await updateChatMetadata(app.db, chatId, { topic: "renamed topic" });
    expect((await activityAtOf(app, chatId))?.getTime()).toBe(before?.getTime());

    // Genuine description change: activity bumps forward.
    await updateChatMetadata(app.db, chatId, { description: "reviewing PR; CI green" });
    const after = await activityAtOf(app, chatId);
    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });
});
