import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import {
  ackEntryByIdForBoundAgents,
  PRECEDING_CONTEXT_MAX_ENTRIES,
  pollInbox,
  pruneStaleSilentEntries,
} from "../services/inbox.js";
import { sendMessage } from "../services/message.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * Pin "silent inbox + preceding context" behaviour (proposal §1):
 *
 * - In a group, every non-sender participant gets an inbox row, but
 *   `mention_only` participants who weren't @mentioned get `notify=false`
 *   ("silent context").
 * - `pollInbox` only claims `notify=true` entries — silent rows never wake
 *   the recipient's session on their own.
 * - When the agent IS @mentioned later, the next claimed trigger carries
 *   `precedingMessages` filled with the silent rows that occurred before it
 *   in the same chat. The silent rows are bulk-acked at the same time so
 *   they don't replay on subsequent polls.
 * - Two consecutive triggers in the same chat split the silent timeline:
 *   the first trigger gets context up to itself, the second gets only
 *   what came between them.
 */
describe("silent inbox + preceding context", () => {
  const getApp = useTestApp();

  async function setupGroupWithMentionOnlyAgent(uid: string) {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `si-${uid}` });
    const human = await createAgent(app.db, {
      name: `si-h-${uid}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const observer = await createAgent(app.db, {
      name: `si-obs-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    // The full-mode control participant has to be a human — Phase 1's
    // participant-mode invariant (chat-participant-mode-fix-design.md §2.1)
    // forces every non-human in a group chat to `mention_only`, so a
    // non-human peer would no longer give us the "still wakes on every
    // message" baseline this suite needs as a control.
    const peer = await createAgent(app.db, {
      name: `si-peer-${uid}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const chat = await createChat(app.db, human.uuid, {
      type: "group",
      participantIds: [observer.uuid, peer.uuid],
    });
    // Phase 1 already seeds `observer` (non-human) as `mention_only` on
    // creation, so the previous defensive `UPDATE chat_membership SET
    // mode = 'mention_only' WHERE agent_id = observer` is no longer
    // required. Keep the read-back contract: assert nothing here, the
    // tests below read modes via inbox effects directly.
    return { human, observer, peer, chat };
  }

  it("writes a silent inbox row for an unmentioned mention_only participant", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "anyone awake?" });

    const rows = await app.db
      .select({ notify: inboxEntries.notify, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, observer.inboxId), eq(inboxEntries.chatId, chat.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notify).toBe(false);
    expect(rows[0]?.status).toBe("pending");
  });

  it("pollInbox does NOT claim silent rows on their own", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "still no @observer" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "second silent one" });

    const pulled = await pollInbox(app.db, observer.inboxId, 10);
    expect(pulled).toHaveLength(0);
  });

  it("bundles silent context onto the next active delivery and bulk-acks the silent rows", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    // Three silent messages, then one that explicitly mentions observer.
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "first silent" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "second silent" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "third silent" });
    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} please weigh in`,
    });

    const pulled = await pollInbox(app.db, observer.inboxId, 10);
    expect(pulled).toHaveLength(1);
    const entry = pulled[0];
    if (!entry) throw new Error("entry missing");

    expect(entry.message.content).toContain("please weigh in");
    expect(entry.message.precedingMessages).toHaveLength(3);
    expect(entry.message.precedingMessages.map((p) => p.content)).toEqual([
      "first silent",
      "second silent",
      "third silent",
    ]);

    // Pin the runtime types of the bigserial / integer columns. The claim
    // path historically returned `id` and `retryCount` as JS strings because
    // the raw-SQL `tx.execute` bypassed Drizzle's column-mode conversion;
    // anything downstream that strictly validated `z.number()` would reject
    // the frame. See issue #194.
    expect(typeof entry.id).toBe("number");
    expect(typeof entry.retryCount).toBe("number");

    // All silent rows should now be acked.
    const remaining = await app.db
      .select({ notify: inboxEntries.notify, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, observer.inboxId), eq(inboxEntries.chatId, chat.id)));
    const silentRemaining = remaining.filter((r) => r.notify === false);
    expect(silentRemaining.every((r) => r.status === "acked")).toBe(true);
  });

  it("does not replay silent context that was already bundled into a previous delivery", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    // First wave: M1 (silent), M2 (silent), M3 (mentions observer).
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "m1" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "m2" });
    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} m3`,
    });

    const firstPull = await pollInbox(app.db, observer.inboxId, 10);
    expect(firstPull).toHaveLength(1);
    const firstEntry = firstPull[0];
    if (!firstEntry) throw new Error("first entry missing");
    expect(firstEntry.message.precedingMessages.map((p) => p.content)).toEqual(["m1", "m2"]);
    await ackEntryByIdForBoundAgents(app.db, firstEntry.id, [observer.inboxId]);

    // Second wave: M4 (silent), M5 (silent), M6 (mentions observer).
    // m1/m2 have been acked, so they should NOT appear again.
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "m4" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "m5" });
    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} m6`,
    });

    const secondPull = await pollInbox(app.db, observer.inboxId, 10);
    expect(secondPull).toHaveLength(1);
    const secondEntry = secondPull[0];
    if (!secondEntry) throw new Error("second entry missing");
    expect(secondEntry.message.precedingMessages.map((p) => p.content)).toEqual(["m4", "m5"]);
  });

  it("splits silent context across two consecutive triggers in the same chat", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    // Timeline: silent-1, mention-1, silent-2, mention-2 — all before the
    // observer ever polls. The first trigger should carry [silent-1] and the
    // second should carry [silent-2], not [silent-1, silent-2].
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "silent-1" });
    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} mention-1`,
    });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "silent-2" });
    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} mention-2`,
    });

    const pulled = await pollInbox(app.db, observer.inboxId, 10);
    expect(pulled).toHaveLength(2);
    const [first, second] = pulled;
    if (!first || !second) throw new Error("expected two entries");
    expect(first.message.content).toContain("mention-1");
    expect(first.message.precedingMessages.map((p) => p.content)).toEqual(["silent-1"]);
    expect(second.message.content).toContain("mention-2");
    expect(second.message.precedingMessages.map((p) => p.content)).toEqual(["silent-2"]);
  });

  it("caps preceding context at PRECEDING_CONTEXT_MAX_ENTRIES and keeps the rows closest to the trigger", async () => {
    // When silent rows exceed the cap, the bundled context must be the LATEST
    // N before the trigger (the most contextually relevant), not the oldest.
    // Older rows still get bulk-acked so they don't accumulate.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    const cap = PRECEDING_CONTEXT_MAX_ENTRIES;
    const overflow = 10;
    const silentCount = cap + overflow;
    const pad = (i: number) => `silent-${String(i).padStart(3, "0")}`;
    for (let i = 0; i < silentCount; i++) {
      await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: pad(i) });
    }
    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} please weigh in`,
    });

    const pulled = await pollInbox(app.db, observer.inboxId, 10);
    expect(pulled).toHaveLength(1);
    const entry = pulled[0];
    if (!entry) throw new Error("entry missing");

    const preceding = entry.message.precedingMessages;
    expect(preceding).toHaveLength(cap);
    // Window kept = the `cap` rows closest to the trigger, oldest-first.
    // The first `overflow` rows (silent-000 … silent-009) get dropped.
    const expected = Array.from({ length: cap }, (_, i) => pad(silentCount - cap + i));
    expect(preceding.map((p) => p.content)).toEqual(expected);

    // All silent rows — including the 10 dropped ones — must be acked so they
    // don't replay onto the next trigger.
    const remaining = await app.db
      .select({ notify: inboxEntries.notify, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, observer.inboxId), eq(inboxEntries.chatId, chat.id)));
    const silentRemaining = remaining.filter((r) => r.notify === false);
    expect(silentRemaining).toHaveLength(silentCount);
    expect(silentRemaining.every((r) => r.status === "acked")).toBe(true);
  });

  it("full-mode participants still wake on every group message and carry no preceding context", async () => {
    // Sanity check — silent inbox is a mention_only-only optimisation. A
    // full-mode participant in the same group should keep the existing
    // notify=true semantics with empty precedingMessages.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, peer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "hello team" });
    const pulled = await pollInbox(app.db, peer.inboxId, 10);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]?.message.precedingMessages).toEqual([]);
  });

  it("excludes silent rows older than the 24h context window from preceding", async () => {
    // The 24h window keeps stale chatter out of the prompt. We can't time-
    // travel the clock, so we backdate the row directly via SQL. The cap test
    // proved the LIMIT semantics; this one isolates the time-window filter.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    // Two silent rows: one fresh, one >24h old.
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "stale-old" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "fresh-recent" });
    // Backdate the first silent inbox entry to 25 hours ago.
    await app.db.execute(sql`
      UPDATE inbox_entries
      SET created_at = NOW() - make_interval(hours => 25)
      WHERE inbox_id = ${observer.inboxId}
        AND chat_id = ${chat.id}
        AND notify = false
        AND id = (
          SELECT id FROM inbox_entries
          WHERE inbox_id = ${observer.inboxId} AND chat_id = ${chat.id} AND notify = false
          ORDER BY id ASC LIMIT 1
        )
    `);

    await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@si-obs-${uid} please weigh in`,
    });

    const pulled = await pollInbox(app.db, observer.inboxId, 10);
    expect(pulled).toHaveLength(1);
    const entry = pulled[0];
    if (!entry) throw new Error("entry missing");
    // Only the fresh row makes the cut; the backdated one is window-excluded.
    expect(entry.message.precedingMessages.map((p) => p.content)).toEqual(["fresh-recent"]);

    // The window-excluded silent row is still bulk-acked so it doesn't
    // re-attach to a future trigger — it's just dropped from the prompt.
    const remaining = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, observer.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
        ),
      );
    expect(remaining.every((r) => r.status === "acked")).toBe(true);
  });

  it("collects silent context per (inbox, chatId) when one poll returns triggers from multiple chats", async () => {
    // Same agent participates in two groups. Both produce a trigger before
    // the agent polls. The single pollInbox call must split silent-row
    // collection by chatId so context from chat A doesn't leak into chat B's
    // preceding (and vice versa).
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const ctx = await createAdminContext(app, { username: `mc-${uid}` });
    const human = await createAgent(app.db, { name: `mc-h-${uid}`, type: "human", managerId: ctx.memberId });
    const observer = await createAgent(app.db, {
      name: `mc-obs-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const filler = await createAgent(app.db, {
      name: `mc-fill-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chatA = await createChat(app.db, human.uuid, {
      type: "group",
      participantIds: [observer.uuid, filler.uuid],
    });
    const chatB = await createChat(app.db, human.uuid, {
      type: "group",
      participantIds: [observer.uuid, filler.uuid],
    });
    for (const chatId of [chatA.id, chatB.id]) {
      await app.db
        .update(chatMembership)
        .set({ mode: "mention_only" })
        .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, observer.uuid)));
    }

    // Chat A: silent-A then mention-A. Chat B: silent-B then mention-B.
    await sendMessage(app.db, chatA.id, human.uuid, { format: "text", content: "silent-A" });
    await sendMessage(app.db, chatA.id, human.uuid, {
      format: "text",
      content: `@mc-obs-${uid} mention-A`,
    });
    await sendMessage(app.db, chatB.id, human.uuid, { format: "text", content: "silent-B" });
    await sendMessage(app.db, chatB.id, human.uuid, {
      format: "text",
      content: `@mc-obs-${uid} mention-B`,
    });

    const pulled = await pollInbox(app.db, observer.inboxId, 10);
    expect(pulled).toHaveLength(2);
    const byChat = new Map(pulled.map((e) => [e.chatId, e] as const));
    const a = byChat.get(chatA.id);
    const b = byChat.get(chatB.id);
    if (!a || !b) throw new Error("expected one entry per chat");
    expect(a.message.precedingMessages.map((p) => p.content)).toEqual(["silent-A"]);
    expect(b.message.precedingMessages.map((p) => p.content)).toEqual(["silent-B"]);
  });

  it("replyTo-routed entries do not pull silent context from the secondary chat", async () => {
    // The replyTo cross-chat route writes an extra inbox row with a chat_id
    // that's *not* the message's home chat. silent-context lookup keys on the
    // entry's chat_id, so the routed entry must look at chat B's silent rows
    // (where it lives) — not chat A's.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const ctx = await createAdminContext(app, { username: `rt-${uid}` });
    const sender = await createAgent(app.db, {
      name: `rt-s-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const peer = await createAgent(app.db, {
      name: `rt-p-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Chat A: sender + peer. Sender will write the original message here with
    // replyTo pointing at chat B (a private group with sender alone).
    const chatA = await createChat(app.db, sender.uuid, { type: "direct", participantIds: [peer.uuid] });
    const chatB = await createChat(app.db, sender.uuid, { type: "group", participantIds: [] });

    // Original — establishes replyTo routing.
    const original = await sendMessage(app.db, chatA.id, sender.uuid, {
      format: "text",
      content: "any progress?",
      replyToInbox: sender.inboxId,
      replyToChat: chatB.id,
    });

    // Peer drains the message they got in chat A.
    await pollInbox(app.db, peer.inboxId, 10);

    // Peer replies in chat A — fan-out drops a row in chat A for sender (full
    // mode here, not mention_only) AND replyTo routing drops a second row in
    // chat B with chat_id=B.
    const reply = await sendMessage(app.db, chatA.id, peer.uuid, {
      format: "text",
      content: "yes, almost done",
      inReplyTo: original.message.id,
    });

    // Sender polls — should get both rows; neither carries any preceding
    // silent context (no silent rows exist in either chat).
    const pulled = await pollInbox(app.db, sender.inboxId, 10);
    expect(pulled.length).toBeGreaterThanOrEqual(1);
    for (const entry of pulled) {
      expect(entry.messageId).toBe(reply.message.id);
      expect(entry.message.precedingMessages).toEqual([]);
    }
    // Confirm the routed row exists on chat B's chat_id.
    const chatIds = pulled.map((e) => e.chatId).sort();
    expect(chatIds).toContain(chatB.id);
  });

  it("pruneStaleSilentEntries deletes acked silent rows immediately and stale-pending rows past the age window", async () => {
    // GC keeps the inbox_entries table from growing forever in chats where a
    // mention_only agent is never @mentioned. Acked rows are deleted on any
    // age (they've fulfilled their replay purpose); pending rows survive
    // until they pass the configured max age.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await setupGroupWithMentionOnlyAgent(uid);

    // Silent row #1 — will be acked first (still fresh).
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "silent-acked" });
    // Mark it acked manually (bulk-ack would happen on next mention, but we
    // isolate the GC behaviour from mention timing here).
    await app.db
      .update(inboxEntries)
      .set({ status: "acked", ackedAt: new Date() })
      .where(
        and(
          eq(inboxEntries.inboxId, observer.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
        ),
      );

    // Silent row #2 — fresh pending (within the age window).
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "silent-fresh-pending" });

    // Silent row #3 — backdated past the age window.
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "silent-stale-pending" });
    // Use a 1-second age limit + backdate the latest row 2 seconds.
    await app.db.execute(sql`
      UPDATE inbox_entries
      SET created_at = NOW() - make_interval(secs => 2)
      WHERE inbox_id = ${observer.inboxId}
        AND chat_id = ${chat.id}
        AND status = 'pending'
        AND notify = false
        AND id = (
          SELECT id FROM inbox_entries
          WHERE inbox_id = ${observer.inboxId} AND chat_id = ${chat.id}
            AND status = 'pending' AND notify = false
          ORDER BY id DESC LIMIT 1
        )
    `);

    const result = await pruneStaleSilentEntries(app.db, /* maxAgeSeconds */ 1);
    expect(result.ackedDeleted).toBe(1); // silent-acked
    expect(result.stalePendingDeleted).toBe(1); // silent-stale-pending

    // The fresh-pending row survives both passes.
    const surviving = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, observer.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
        ),
      );
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.status).toBe("pending");
  });
});
