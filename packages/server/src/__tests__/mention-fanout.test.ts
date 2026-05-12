import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { addParticipant, createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Server-authoritative mention resolution + fan-out filtering. The server is
 * the single place that:
 *   1. Parses `@<name>` tokens from content against the chat's participants.
 *   2. Merges the result with caller-provided `metadata.mentions`.
 *   3. Withholds inbox_entries from `mention_only` participants who are not
 *      in the final mention set.
 *
 * These tests exercise the sendMessage service directly so behaviour is pinned
 * regardless of which HTTP path (agent / admin / adapter) produced the call.
 */
describe("server mention resolution + fan-out filter", () => {
  const getApp = useTestApp();

  /**
   * Only counts rows that will *wake the recipient's session* (notify=true).
   * Silent context rows (notify=false) — written for `mention_only` participants
   * who weren't @mentioned — are intentionally excluded here so existing
   * "is this participant in the active fan-out?" assertions still mean
   * "would this agent's session be woken?". Silent-row behaviour is covered by
   * the dedicated tests in `silent-inbox-context.test.ts`.
   */
  async function inboxEntriesFor(app: ReturnType<typeof getApp>, chatId: string, agentUuid: string) {
    const [row] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, agentUuid))
      .limit(1);
    if (!row) return [];
    return app.db
      .select({ messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(
        and(eq(inboxEntries.inboxId, row.inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)),
      );
  }

  async function setParticipantMode(
    app: ReturnType<typeof getApp>,
    chatId: string,
    agentUuid: string,
    mode: "full" | "mention_only",
  ) {
    await app.db
      .update(chatParticipants)
      .set({ mode })
      .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, agentUuid)));
  }

  /**
   * Build a 3-agent group chat: sender (full), observer-A (mention_only),
   * observer-B (mention_only). The sender always writes; the two observers
   * are what we assert on.
   */
  async function setupGroup(app: ReturnType<typeof getApp>, uid: string) {
    const sender = await createTestAgent(app, { name: `mf-sender-${uid}` });
    const { agent: obsA } = await createTestAgent(app, { name: `mf-obsA-${uid}` });
    const { agent: obsB } = await createTestAgent(app, { name: `mf-obsB-${uid}` });

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [obsA.uuid, obsB.uuid],
    });
    // createChat seeds the new participants as mention_only-unless-explicit;
    // force the intended modes so the test isn't entangled with that default.
    await setParticipantMode(app, chat.id, sender.agent.uuid, "full");
    await setParticipantMode(app, chat.id, obsA.uuid, "mention_only");
    await setParticipantMode(app, chat.id, obsB.uuid, "mention_only");

    return { sender, obsA, obsB, chat };
  }

  it("resolves `@<name>` from content and fans out only to named mention_only participants", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: `@mf-obsA-${uid} please review`,
    });

    const obsAEntries = await inboxEntriesFor(app, chat.id, obsA.uuid);
    const obsBEntries = await inboxEntriesFor(app, chat.id, obsB.uuid);
    expect(obsAEntries).toHaveLength(1);
    expect(obsBEntries).toHaveLength(0);
  });

  it("full-mode participants receive the entry even when not mentioned", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, chat } = await setupGroup(app, uid);
    // Flip obsA to full — they should always receive regardless of @tokens.
    await setParticipantMode(app, chat.id, obsA.uuid, "full");

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: "nothing specific, team",
    });

    const obsAEntries = await inboxEntriesFor(app, chat.id, obsA.uuid);
    expect(obsAEntries).toHaveLength(1);
  });

  it("merges explicit metadata.mentions with content-resolved mentions", async () => {
    // Caller passes `mentions: [obsA]` explicitly AND text @obsB — both should
    // receive. Server-side resolution is additive, not overriding.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: `heads up @mf-obsB-${uid}`,
      metadata: { mentions: [obsA.uuid] },
    });

    const obsAEntries = await inboxEntriesFor(app, chat.id, obsA.uuid);
    const obsBEntries = await inboxEntriesFor(app, chat.id, obsB.uuid);
    expect(obsAEntries).toHaveLength(1);
    expect(obsBEntries).toHaveLength(1);
  });

  it("code-fenced `@name` does NOT trigger fan-out (three-gate algorithm)", async () => {
    // Pins the defensive gate shared with the client-side extractor: @tokens
    // inside ```...``` or `inline code` are ignored so sample code doesn't
    // accidentally wake agents.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: `look at this:\n\`\`\`\n@mf-obsA-${uid} bad code\n\`\`\``,
    });

    const obsAEntries = await inboxEntriesFor(app, chat.id, obsA.uuid);
    expect(obsAEntries).toHaveLength(0);
  });

  it("unknown `@token` is silently dropped — does not wake any agent", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: "@nobody-by-that-name hi",
    });

    expect(await inboxEntriesFor(app, chat.id, obsA.uuid)).toHaveLength(0);
    expect(await inboxEntriesFor(app, chat.id, obsB.uuid)).toHaveLength(0);
  });

  it("persists the resolved mentions into message.metadata for downstream reads", async () => {
    // Pins that the merged mention list is stored on the message row — not
    // only used as a transient fan-out signal — so replyTo routing / audit /
    // UI highlighting can all read the same source of truth.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, chat } = await setupGroup(app, uid);

    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: `@mf-obsA-${uid} hi`,
    });

    const meta = (message.metadata ?? {}) as { mentions?: unknown };
    expect(Array.isArray(meta.mentions)).toBe(true);
    expect(meta.mentions).toEqual([obsA.uuid]);
  });

  // addParticipant seeds the new participant with mode="full" per its schema
  // default; explicitly verifying newcomers don't silently become mention_only
  // is out of scope here (covered by chat-upgrade.test.ts) — but pinning the
  // "mention_only newcomer still needs @" invariant is.
  it("mention_only participant added AFTER the message does not retroactively receive it", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: "earlier chatter",
    });

    // Add a new participant AFTER the message. Phase 1 derives mode from
    // `(chats.type, agents.type)`; a non-human agent joining a group chat
    // lands in `mention_only` automatically, which is exactly what this
    // test needs to assert.
    const { agent: late } = await createTestAgent(app, { name: `mf-late-${uid}` });
    await app.db.update(agents).set({ managerId: sender.memberId }).where(eq(agents.uuid, late.uuid));
    await addParticipant(app.db, chat.id, sender.agent.uuid, { agentId: late.uuid });

    expect(await inboxEntriesFor(app, chat.id, late.uuid)).toHaveLength(0);
  });

  it("does not emit a `mentions` field on the message when no mentions were found", async () => {
    // Keep the wire payload lean: an empty mention set should leave the
    // metadata object untouched rather than stamping `mentions: []`.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, chat } = await setupGroup(app, uid);
    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: "generic chatter, no @anyone",
    });
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("mentions");
    // Should still fan out nothing beyond the sender (two mention_only peers).
    expect(await app.db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(1);
  });
});
