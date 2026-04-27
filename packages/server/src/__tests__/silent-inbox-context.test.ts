import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatParticipants } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { ackEntry, pollInbox } from "../services/inbox.js";
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
    const peer = await createAgent(app.db, {
      name: `si-peer-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, human.uuid, {
      type: "group",
      participantIds: [observer.uuid, peer.uuid],
    });
    // Force observer to mention_only; everyone else stays full so they receive
    // every message and won't pollute these assertions.
    await app.db
      .update(chatParticipants)
      .set({ mode: "mention_only" })
      .where(and(eq(chatParticipants.chatId, chat.id), eq(chatParticipants.agentId, observer.uuid)));
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
    await ackEntry(app.db, firstEntry.id, observer.inboxId);

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
});
