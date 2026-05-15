import type { InboxEntryWithMessage } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createChat, findOrCreateDirectChat } from "../services/chat.js";
import { ackEntry, pollInbox } from "../services/inbox.js";
import { listMessages, sendMessage, sendToAgent } from "../services/message.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * End-to-end coverage for the four messaging scenarios pinned in
 * proposals/hub-agent-messaging-reply-and-mentions §六. Exercises the real
 * server fan-out + replyTo routing + dispatcher, and evaluates the runtime's
 * suppression / mention-filter rules against the actual payload that would
 * reach a client. Duplicates the decision logic here so the assertion is
 * explicit and the server tests stay self-contained (the ≈10-line helpers
 * are pinned separately in `client/__tests__/session-manager.test.ts`).
 */

type Entry = Awaited<ReturnType<typeof pollInbox>>[number];

/**
 * Mirrors `shouldSuppressEcho` from `@first-tree-hub/client`. Kept local so
 * the server test package doesn't need a cross-package import at test time;
 * the production version is independently unit-tested.
 */
function suppressEcho(entry: Entry, myAgentId: string): boolean {
  const snap = entry.message.inReplyToSnapshot;
  if (!snap) return false;
  const entryChat = entry.chatId ?? entry.message.chatId;
  if (snap.senderId !== myAgentId) return false;
  if (snap.chatId !== entryChat) return false;
  if (snap.replyToChat === null) return false;
  return snap.replyToChat !== entryChat;
}

function skipForMode(entry: Entry, myAgentId: string): boolean {
  if (entry.message.recipientMode !== "mention_only") return false;
  const raw = (entry.message.metadata as { mentions?: unknown }).mentions;
  if (!Array.isArray(raw)) return true;
  return !raw.some((m) => m === myAgentId);
}

async function ackAll(app: { db: Parameters<typeof ackEntry>[0] }, entries: Entry[], inboxId: string) {
  for (const e of entries) {
    await ackEntry(app.db, e.id, inboxId);
  }
}

describe("messaging E2E — proposal §六 scenarios", () => {
  const getApp = useTestApp();

  it("Case A: direct-chat task hand-off produces no echo (No-echo invariant)", async () => {
    // Recreates the original bug report: a1 ↔ b1 in c1; b1 delegates to b2 in
    // c2; b2 auto-forwards; b1 must wake in c1 and NOT loop in c2.
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2ea-${Date.now()}` });
    const a1 = await createAgent(app.db, {
      name: `e2ea-a1-${Date.now()}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const b1 = await createAgent(app.db, {
      name: `e2ea-b1-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2ea-b2-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const c1 = await createChat(app.db, a1.uuid, { type: "direct", participantIds: [b1.uuid] });

    // a1 → c1: human asks b1 for a summary.
    await sendMessage(app.db, c1.id, a1.uuid, { format: "text", content: "summarize xxx via b2" });

    // Simulate b1's runtime: pull, then "CLI agent send b2" from the c1 session.
    const b1PulledInit = await pollInbox(app.db, b1.inboxId, 10);
    expect(b1PulledInit).toHaveLength(1);
    const humanMsg = b1PulledInit[0];
    if (!humanMsg) throw new Error("unreachable");
    expect(humanMsg.chatId).toBe(c1.id);
    expect(humanMsg.message.inReplyToSnapshot).toBeNull();
    expect(suppressEcho(humanMsg, b1.uuid)).toBe(false);

    // b2 is not a member of c1; v1 §四 改造 1 routes this through the
    // explicit direct-chat path via `direct: true`.
    await sendToAgent(app.db, b1.uuid, b2.name as string, {
      format: "text",
      content: "please summarize",
      replyToInbox: b1.inboxId,
      replyToChat: c1.id,
      direct: true,
    });
    await ackAll(app, b1PulledInit, b1.inboxId);

    // Simulate b2's runtime: pull, then auto-forward result.
    const b2Pulled = await pollInbox(app.db, b2.inboxId, 10);
    expect(b2Pulled).toHaveLength(1);
    const b1Request = b2Pulled[0];
    if (!b1Request) throw new Error("unreachable");
    // c2 is the b1-b2 direct chat.
    const c2Id = b1Request.chatId ?? b1Request.message.chatId;
    expect(suppressEcho(b1Request, b2.uuid)).toBe(false);

    await sendMessage(app.db, c2Id, b2.uuid, {
      format: "text",
      content: "done: here's the summary",
      inReplyTo: b1Request.message.id,
    });
    await ackAll(app, b2Pulled, b2.inboxId);

    // Simulate b1's runtime polling again. Under migration 0029, c2
    // (b1↔b2 agent-only direct) is `mention_only` on both ends, so b2's
    // reply lands as a SILENT context row in c2 (not delivered to b1's
    // active poll) — the no-echo invariant is now enforced at the inbox
    // layer instead of by the runtime's suppression filter. The c1 entry
    // survives because replyTo routing always inserts notify=true.
    const b1Pulled2 = await pollInbox(app.db, b1.inboxId, 10);
    expect(b1Pulled2).toHaveLength(1);

    const byChat = new Map<string, InboxEntryWithMessage>(
      b1Pulled2.map((e) => [e.chatId ?? e.message.chatId, e as InboxEntryWithMessage]),
    );
    const c1Entry = byChat.get(c1.id);
    if (!c1Entry) throw new Error("expected c1 entry from replyTo routing");
    expect(byChat.has(c2Id)).toBe(false);

    // The surviving entry carries the same snapshot (original M1 from b1 in c2).
    expect(c1Entry.message.inReplyToSnapshot).toEqual({
      senderId: b1.uuid,
      chatId: c2Id,
      replyToChat: c1.id,
    });

    // c1 entry: snapshot.chatId (c2) ≠ entryChatId (c1) → keep, wake c1 session.
    expect(suppressEcho(c1Entry, b1.uuid)).toBe(false);

    // No-echo invariant: c2 has exactly M1 (b1→b2) + M2 (b2→b1), stays at 2
    // regardless of how many times b1 polls.
    const c2Msgs = await listMessages(app.db, c2Id, 10);
    expect(c2Msgs.items).toHaveLength(2);
    const senders = c2Msgs.items.map((m) => m.senderId).sort();
    expect(senders).toEqual([b1.uuid, b2.uuid].sort());
  });

  it("Case B: b1 starts the conversation inside c2 itself — suppression must NOT fire", async () => {
    // b1 opens c2 directly (replyTo = c2 itself, not c1). Subsequent replies
    // should wake b1 in c2, not get dropped as echo.
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2eb-${Date.now()}` });
    const b1 = await createAgent(app.db, {
      name: `e2eb-b1-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2eb-b2-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const c2 = await findOrCreateDirectChat(app.db, b1.uuid, b2.uuid);

    // b1 writes in c2 with replyTo = c2 itself. Both ends are mention_only
    // (migration 0029) so b1 must @-mention b2 explicitly to wake the peer.
    const m1 = await sendMessage(app.db, c2.id, b1.uuid, {
      format: "text",
      content: "hi",
      replyToInbox: b1.inboxId,
      replyToChat: c2.id,
      metadata: { mentions: [b2.uuid] },
    });

    // b2 auto-forwards. Same rule applies — b2's reply must mention b1.
    const b2Pulled = await pollInbox(app.db, b2.inboxId, 10);
    expect(b2Pulled).toHaveLength(1);
    await sendMessage(app.db, c2.id, b2.uuid, {
      format: "text",
      content: "reply",
      inReplyTo: m1.message.id,
      metadata: { mentions: [b1.uuid] },
    });
    await ackAll(app, b2Pulled, b2.inboxId);

    // b1 polls — the replyTo and fan-out collapse into a single entry (same
    // inboxId/messageId/chatId → onConflictDoNothing). Either way, the entry
    // must NOT be suppressed.
    const b1Pulled = await pollInbox(app.db, b1.inboxId, 10);
    expect(b1Pulled.length).toBeGreaterThanOrEqual(1);
    for (const e of b1Pulled) {
      expect(suppressEcho(e, b1.uuid)).toBe(false);
    }
    // All b1's entries live in c2 (the replyTo target == fanout chat).
    for (const e of b1Pulled) {
      expect(e.chatId).toBe(c2.id);
    }
  });

  it("Case C: group @mention activates only the targeted agent (Mention-filter invariant)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2ec-${Date.now()}` });
    const a1 = await createAgent(app.db, {
      name: `e2ec-a1-${Date.now()}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const b1 = await createAgent(app.db, {
      name: `e2ec-b1-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2ec-b2-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Group with human + two agents. a1 owner (full), b1 & b2 are added as
    // members — createChat keeps them at default "full". We simulate the
    // Case C post-upgrade state by relying on the agent-side @mention logic
    // only: modes matter for dispatcher output, so set them.
    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [b1.uuid, b2.uuid],
    });
    const { chatMembership } = await import("../db/schema/chat-membership.js");
    const { and, eq, inArray } = await import("drizzle-orm");
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), inArray(chatMembership.agentId, [b1.uuid, b2.uuid])));

    // Human messages with explicit mention of b1.
    await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "@b1 please look",
      metadata: { mentions: [b1.uuid] },
    });

    const b1Pulled = await pollInbox(app.db, b1.inboxId, 10);
    const b2Pulled = await pollInbox(app.db, b2.inboxId, 10);
    // Server-side fan-out is now authoritative for the mention filter:
    // mention_only + not mentioned → no inbox_entry written. b2 therefore
    // receives nothing. The local `skipForMode` mirror is retained for
    // Case D where a replyTo target is a mention_only participant on a
    // different chat — that path still lives on the client.
    expect(b1Pulled).toHaveLength(1);
    expect(b2Pulled).toHaveLength(0);

    // b1's payload still carries its participant mode so the dispatcher /
    // handler can read context if needed.
    expect(b1Pulled[0]?.message.recipientMode).toBe("mention_only");
    expect(skipForMode(b1Pulled[0] as Entry, b1.uuid)).toBe(false);
  });

  it("Case D: b1's reply with explicit @b3 activates b3 (not b2)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2ed-${Date.now()}` });
    const a1 = await createAgent(app.db, {
      name: `e2ed-a1-${Date.now()}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const b1 = await createAgent(app.db, {
      name: `e2ed-b1-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2ed-b2-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b3 = await createAgent(app.db, {
      name: `e2ed-b3-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [b1.uuid, b2.uuid, b3.uuid],
    });
    const { chatMembership } = await import("../db/schema/chat-membership.js");
    const { and, eq, inArray } = await import("drizzle-orm");
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), inArray(chatMembership.agentId, [b1.uuid, b2.uuid, b3.uuid])));

    // a1 pings b1.
    const ping = await sendMessage(app.db, chat.id, a1.uuid, {
      format: "text",
      content: "@b1 thoughts?",
      metadata: { mentions: [b1.uuid] },
    });

    // b1's runtime processes, then auto-forwards with mentions=[a1, b3].
    await pollInbox(app.db, b1.inboxId, 10);
    await sendMessage(app.db, chat.id, b1.uuid, {
      format: "text",
      content: "rough plan. @b3 can you sanity-check?",
      inReplyTo: ping.message.id,
      metadata: { mentions: [a1.uuid, b3.uuid] },
    });

    // Each observer polls its inbox for both messages.
    // Since drain is message-by-message in these tests, poll enough to
    // collect every entry — 10 covers it.
    const b2All = await pollInbox(app.db, b2.inboxId, 10);
    const b3All = await pollInbox(app.db, b3.inboxId, 10);
    const a1All = await pollInbox(app.db, a1.inboxId, 10);

    // b2 must not receive EITHER message — server-authoritative fan-out
    // withholds inbox_entries from mention_only participants not in the
    // mention set. Assert length explicitly so a regression that starts
    // delivering to b2 doesn't pass vacuously through an empty for-loop.
    expect(b2All).toHaveLength(0);
    // b3 receives b1's reply mentioning him — must NOT skip that one.
    const b3Reply = b3All.find((e) => e.message.inReplyTo === ping.message.id);
    expect(b3Reply).toBeDefined();
    if (b3Reply) expect(skipForMode(b3Reply, b3.uuid)).toBe(false);
    // a1 is full-mode — never skipped regardless of mentions.
    for (const e of a1All) {
      expect(skipForMode(e, a1.uuid)).toBe(false);
    }
  });

  it("Message-immutability invariant: edits do not re-route or re-fan out", async () => {
    // Proposal §八 invariant 4: messages are immutable (UUID v7 ordering +
    // append-only fan-out). `editMessage` is only supposed to patch content
    // in-place; it must NOT trigger a second fan-out or a second replyTo
    // routing, and it must NOT change replyTo fields. This test pins that.
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2eimm-${Date.now()}` });
    const b1 = await createAgent(app.db, {
      name: `e2eimm-b1-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2eimm-b2-${Date.now()}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const c1 = await findOrCreateDirectChat(app.db, b1.uuid, b2.uuid);

    // Send M1 from b1 with a replyTo envelope. Mention b2 explicitly:
    // c1 is a mention_only direct (migration 0029) so the active fan-out
    // entry only lands when the recipient is in the mention set.
    const m1 = await sendMessage(app.db, c1.id, b1.uuid, {
      format: "text",
      content: "first cut",
      replyToInbox: b1.inboxId,
      replyToChat: c1.id,
      metadata: { mentions: [b2.uuid] },
    });

    // b2 drains so we observe the PRE-edit fan-out count (1 entry).
    const b2Before = await pollInbox(app.db, b2.inboxId, 10);
    expect(b2Before).toHaveLength(1);
    await ackAll(app, b2Before, b2.inboxId);

    // Edit M1's content. We import editMessage inline so the suite's import
    // block stays focused on the happy-path messaging primitives.
    const { editMessage } = await import("../services/message.js");
    await editMessage(app.db, c1.id, m1.message.id, b1.uuid, { content: "first cut — revised" });

    // No new inbox entries should have been written — b2 pulls nothing.
    const b2After = await pollInbox(app.db, b2.inboxId, 10);
    expect(b2After).toHaveLength(0);

    // The on-disk message row retains its original replyTo envelope, and
    // `metadata.editedAt` is the only observable trace of the edit.
    const msgs = await listMessages(app.db, c1.id, 10);
    const edited = msgs.items.find((m) => m.id === m1.message.id);
    if (!edited) throw new Error("edited message missing");
    expect(edited.content).toBe("first cut — revised");
    expect(edited.replyToInbox).toBe(b1.inboxId);
    expect(edited.replyToChat).toBe(c1.id);
    expect((edited.metadata as { editedAt?: string }).editedAt).toBeTypeOf("string");
  });
});
