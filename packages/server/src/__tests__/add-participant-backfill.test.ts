import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { addParticipant, createChat } from "../services/chat.js";
import { PRECEDING_CONTEXT_MAX_ENTRIES, pollInbox } from "../services/inbox.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * v1 §四 改造 2 — `addParticipant()` backfills the chat's most recent N
 * messages as silent (notify=false) inbox rows for the newly added agent so
 * a future trigger replays them as preceding context.
 *
 * These tests pin:
 *   1. Backfill writes `min(N, total)` notify=false rows for the joiner.
 *   2. Old members are NOT woken by the backfill.
 *   3. A chat with no prior messages produces zero backfill rows (no error).
 *   4. The backfill is in the same transaction as the participant insert.
 */

async function countSilentEntries(db: Database, inboxId: string, chatId: string): Promise<number> {
  const rows = await db
    .select({ id: inboxEntries.id })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, inboxId),
        eq(inboxEntries.chatId, chatId),
        eq(inboxEntries.notify, false),
        eq(inboxEntries.status, "pending"),
      ),
    )
    .orderBy(asc(inboxEntries.createdAt));
  return rows.length;
}

async function countNotifyEntries(db: Database, inboxId: string, chatId: string): Promise<number> {
  const rows = await db
    .select({ id: inboxEntries.id })
    .from(inboxEntries)
    .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)));
  return rows.length;
}

describe("addParticipant — silent-context backfill (v1 §四 改造 2)", () => {
  const getApp = useTestApp();

  // `createTestAgent` resolves the same default test org for every call, so
  // the three agents below land in one organisation and `createChat` /
  // `addParticipant` accept them as same-org peers.

  it("writes exactly N silent rows for the joiner when the chat has > N messages, and 0 notify rows", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    const total = PRECEDING_CONTEXT_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i++) {
      await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: `msg-${i}` });
    }

    const ownerSilentBefore = await countSilentEntries(app.db, owner.agent.inboxId, chat.id);
    const peerSilentBefore = await countSilentEntries(app.db, peer.agent.inboxId, chat.id);
    const peerNotifyBefore = await countNotifyEntries(app.db, peer.agent.inboxId, chat.id);

    await addParticipant(app.db, chat.id, owner.agent.uuid, { agentId: newcomer.agent.uuid });

    // Joiner gets exactly N silent rows (capped at PRECEDING_CONTEXT_MAX_ENTRIES).
    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(PRECEDING_CONTEXT_MAX_ENTRIES);
    // Joining itself never wakes the joiner.
    expect(await countNotifyEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(0);

    // Old members' inbox state is unchanged.
    expect(await countSilentEntries(app.db, owner.agent.inboxId, chat.id)).toBe(ownerSilentBefore);
    expect(await countSilentEntries(app.db, peer.agent.inboxId, chat.id)).toBe(peerSilentBefore);
    expect(await countNotifyEntries(app.db, peer.agent.inboxId, chat.id)).toBe(peerNotifyBefore);
  });

  it("writes total < N silent rows when the chat has fewer than N messages", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    const total = 7;
    for (let i = 0; i < total; i++) {
      await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: `m${i}` });
    }

    await addParticipant(app.db, chat.id, owner.agent.uuid, { agentId: newcomer.agent.uuid });

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(total);
    expect(await countNotifyEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(0);
  });

  it("writes zero silent rows when the chat has no messages yet (boundary)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    // No messages sent. addParticipant must not error and must not write rows.
    await addParticipant(app.db, chat.id, owner.agent.uuid, { agentId: newcomer.agent.uuid });

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(0);
    expect(await countNotifyEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(0);
  });

  it("leaves inbox untouched when addParticipant rejects an already-speaker (transactional consistency)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: "hi" });

    const peerSilentBefore = await countSilentEntries(app.db, peer.agent.inboxId, chat.id);
    const peerNotifyBefore = await countNotifyEntries(app.db, peer.agent.inboxId, chat.id);

    await expect(addParticipant(app.db, chat.id, owner.agent.uuid, { agentId: peer.agent.uuid })).rejects.toThrow(
      /already a participant/i,
    );

    // No new inbox rows for the already-present peer.
    expect(await countSilentEntries(app.db, peer.agent.inboxId, chat.id)).toBe(peerSilentBefore);
    expect(await countNotifyEntries(app.db, peer.agent.inboxId, chat.id)).toBe(peerNotifyBefore);
  });

  it("after-join messages still reach the joiner via the existing fan-out (time-gap hand-off)", async () => {
    // t1: addParticipant (backfill writes ≤ N silent rows).
    // t2: chat fan-out delivers further non-mentioning messages to the
    //     joiner as additional silent rows (mention_only + not mentioned).
    // t3 (out of scope here): the next @mention bundles t1 ∪ t2 via
    //     `collectPrecedingContext` — pinned by the existing inbox suite.
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: "before-1" });
    await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: "before-2" });

    await addParticipant(app.db, chat.id, owner.agent.uuid, { agentId: newcomer.agent.uuid });
    const afterJoin = await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id);

    await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: "after-1" });
    await sendMessage(app.db, chat.id, owner.agent.uuid, { source: "api", format: "text", content: "after-2" });

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(afterJoin + 2);
    // No notify rows on the joiner yet — they have not been @-mentioned.
    expect(await countNotifyEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(0);
  });

  it("preceding-context bundling preserves chronological order across the bulk backfill batch", async () => {
    // PR #393 review #2: the 50 silent rows are inserted in one INSERT,
    // so `inboxEntries.createdAt` is identical across all of them. The
    // ordering contract the LLM-facing prompt depends on must come from
    // `messages.createdAt` (uuidv7-derived, monotonic). This test wakes the
    // joiner once and asserts that `precedingMessages` reads oldest-first
    // across the backfill batch — would fail under the old
    // `ORDER BY inboxEntries.createdAt` if the planner returned heap order.
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });
    if (!newcomer.agent.name) throw new Error("newcomer name missing");

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    // Seed enough history for a meaningful ordering check.
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await sendMessage(app.db, chat.id, owner.agent.uuid, {
        source: "api",
        format: "text",
        content: `seed-${i}`,
      });
      seeded.push(r.message.id);
    }

    await addParticipant(app.db, chat.id, owner.agent.uuid, { agentId: newcomer.agent.uuid });

    // Wake the joiner via an explicit @-mention; the preceding-context
    // bundler runs as part of pollInbox.
    await sendMessage(app.db, chat.id, owner.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${newcomer.agent.name} you're up`,
      metadata: { mentions: [newcomer.agent.uuid] },
    });

    const claimed = await pollInbox(app.db, newcomer.agent.inboxId, 5);
    expect(claimed.length).toBe(1);
    const trigger = claimed[0];
    if (!trigger) throw new Error("trigger entry missing");
    const preceding = trigger.message.precedingMessages;
    // All 5 seeded messages should land in the preceding block, ordered
    // oldest → newest.
    const seedIdsInOrder = preceding.filter((p) => seeded.includes(p.id)).map((p) => p.id);
    expect(seedIdsInOrder).toEqual(seeded);
  });
});
