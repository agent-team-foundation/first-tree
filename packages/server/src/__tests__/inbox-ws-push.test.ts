import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { chatParticipants } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import * as inboxService from "../services/inbox.js";
import { sendMessage } from "../services/message.js";
import { createAdminContext, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Coverage for the WS data-plane claim helpers introduced in proposal
 * hub-inbox-ws-data-plane. These are the pure DB primitives — the WS frame
 * round-trip (welcome capability, in-flight cap, backlog drain) is exercised
 * by an integration test layer that depends on a live websocket harness;
 * here we just pin invariants the service layer must guarantee.
 */
describe("inbox WS data-plane claim helpers", () => {
  const getApp = useTestApp();

  async function seedDeliverable(app: FastifyInstance) {
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `wsp-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `wsp-a2-${uid}` });
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;
    // Agent↔agent direct seeds both as mention_only (migration 0029); the
    // claim helpers operate on `pending` rows with `notify=true`, so the
    // seed message must @-mention a2 to land an active row.
    const msgRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.agent.name} WS push test`,
    });
    return { a2, messageId: msgRes.json().id, chatId };
  }

  it("claimAndBuildForPush atomically claims a pending entry and bundles it", async () => {
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const entries = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) return;
    expect(entry.messageId).toBe(messageId);
    expect(entry.status).toBe("delivered");
    expect(entry.message.id).toBe(messageId);
    // Same wire shape as the legacy poll path → client-side dispatch is
    // identical (single SessionManager.dispatch call site).
    expect(typeof entry.message.configVersion).toBe("number");
    expect(entry.message.recipientMode).toBeTruthy();
    // `inbox_entries.id` is bigserial (int8) — postgres-js returns int8 as a
    // JS string by default. The raw-SQL claim path has to coerce to number
    // because the WS push frame schema validates `entryId: z.number()`.
    // Without coercion the client drops every push frame as malformed.
    expect(typeof entry.id).toBe("number");
  });

  it("returns an empty array on a second claim of the same (inbox, message) — race-safe with HTTP poll", async () => {
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const first = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    expect(first).toHaveLength(1);

    // Second claim hits no `pending` row — push path must surface that as
    // `[]`, NOT throw, otherwise a NOTIFY storm crashes the LISTEN loop.
    const second = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    expect(second).toEqual([]);
  });

  it("claimAndBuildForPush returns BOTH rows when replyTo cross-chat fan-out wrote two entries", async () => {
    // Regression for review issue #2: a single (inbox, messageId) pair can map
    // to two inbox_entries rows differing only by chat_id when:
    //   1. agent A is a chat participant (row 1, chatId = current chat)
    //   2. agent A is also the replyToInbox of an earlier message
    //      (row 2, chatId = original.replyToChat)
    // Old `LIMIT 1` claim shape only pushed row 1; row 2 sat `pending` until
    // reconnect. Aligning with poll's `LIMIT N` shape closes the gap.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const ctx = await createAdminContext(app, { username: `wsp-rt-${uid}` });
    const sender = await createAgent(app.db, {
      name: `wsp-rt-s-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const peer = await createAgent(app.db, {
      name: `wsp-rt-p-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // chatA: sender + peer (where the conversation lives).
    // chatB: sender alone — the replyTo target.
    const chatA = await createChat(app.db, sender.uuid, { type: "direct", participantIds: [peer.uuid] });
    const chatB = await createChat(app.db, sender.uuid, { type: "group", participantIds: [] });

    // chatA is mention_only on both ends (migration 0029), so explicit
    // mentions on each leg keep the fan-out + replyTo rows both notify=true
    // — this test is about the WS claim shape, not mode semantics.
    const original = await sendMessage(app.db, chatA.id, sender.uuid, {
      format: "text",
      content: "any progress?",
      replyToInbox: sender.inboxId,
      replyToChat: chatB.id,
      metadata: { mentions: [peer.uuid] },
    });
    // Drain peer's inbox so it doesn't muddy the assertions below.
    await inboxService.pollInbox(app.db, peer.inboxId, 10);

    // peer replies — fan-out writes one row to sender's inbox (chatId=A) AND
    // replyTo routing writes a second row (chatId=B). Same messageId on both.
    const reply = await sendMessage(app.db, chatA.id, peer.uuid, {
      format: "text",
      content: "yes, almost done",
      inReplyTo: original.message.id,
      metadata: { mentions: [sender.uuid] },
    });

    // Sanity check the seed: two pending rows exist before we claim.
    const seeded = await app.db
      .select({ chatId: inboxEntries.chatId, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, sender.inboxId), eq(inboxEntries.messageId, reply.message.id)));
    expect(seeded).toHaveLength(2);

    // The push path must claim BOTH rows in one call — proposal §3.2's
    // "single NOTIFY → all matching pending rows".
    const claimed = await inboxService.claimAndBuildForPush(app.db, sender.inboxId, reply.message.id);
    expect(claimed).toHaveLength(2);
    const claimedChatIds = claimed.map((e) => e.chatId).sort();
    expect(claimedChatIds).toEqual([chatA.id, chatB.id].sort());
    for (const e of claimed) expect(e.status).toBe("delivered");

    // No pending row should be left behind.
    const remaining = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, sender.inboxId), eq(inboxEntries.messageId, reply.message.id)));
    expect(remaining.every((r) => r.status === "delivered")).toBe(true);
  });

  it("claimAndBuildForPush bundles silent context for a mention_only trigger", async () => {
    // Mirror the silent-inbox-context test but on the push path. This is the
    // riskiest piece of the refactor — `bundleDeliveryWithSilentContext` was
    // extracted from `pollInboxInner` to be shared, so a divergence between
    // poll and push silent-context handling would be a silent regression.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const ctx = await createAdminContext(app, { username: `wsp-si-${uid}` });
    const human = await createAgent(app.db, {
      name: `wsp-si-h-${uid}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const observer = await createAgent(app.db, {
      name: `wsp-si-obs-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const peer = await createAgent(app.db, {
      name: `wsp-si-peer-${uid}`,
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, human.uuid, {
      type: "group",
      participantIds: [observer.uuid, peer.uuid],
    });
    await app.db
      .update(chatParticipants)
      .set({ mode: "mention_only" })
      .where(and(eq(chatParticipants.chatId, chat.id), eq(chatParticipants.agentId, observer.uuid)));

    // Three silent messages, then a trigger that @mentions observer.
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "first silent" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "second silent" });
    await sendMessage(app.db, chat.id, human.uuid, { format: "text", content: "third silent" });
    const trigger = await sendMessage(app.db, chat.id, human.uuid, {
      format: "text",
      content: `@wsp-si-obs-${uid} please weigh in`,
    });

    // Push-path claim must bundle the same silent context the poll path would.
    const claimed = await inboxService.claimAndBuildForPush(app.db, observer.inboxId, trigger.message.id);
    expect(claimed).toHaveLength(1);
    const entry = claimed[0];
    if (!entry) throw new Error("claim missing");
    expect(entry.message.precedingMessages.map((p) => p.content)).toEqual([
      "first silent",
      "second silent",
      "third silent",
    ]);

    // Same side effect as the poll path: silent rows bulk-acked so they don't
    // re-attach to a future trigger.
    const silentRemaining = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, observer.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
        ),
      );
    expect(silentRemaining.length).toBeGreaterThan(0);
    expect(silentRemaining.every((r) => r.status === "acked")).toBe(true);
  });

  it("claimBacklogForPush drains pending entries oldest-first up to the limit", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `wspb-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `wspb-a2-${uid}` });
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // mention_only direct (migration 0029): each backlog message must @ a2
    // to land as a notify=true pending row that the backlog claim drains.
    for (let i = 0; i < 3; i++) {
      await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `@${a2.agent.name} msg ${i}`,
      });
    }

    const drained = await inboxService.claimBacklogForPush(app.db, a2.agent.inboxId, 10);
    expect(drained.length).toBe(3);
    // FIFO invariant — proposal §3.3: reply chains and silent-context windows
    // depend on chronological order; reordering here would silently break
    // mention semantics in group chats.
    for (let i = 1; i < drained.length; i++) {
      const prev = drained[i - 1];
      const curr = drained[i];
      if (!prev || !curr) throw new Error("unreachable: drained array bounds");
      expect(prev.createdAt <= curr.createdAt).toBe(true);
    }
    // Every drained entry must be marked delivered atomically with the claim.
    for (const e of drained) expect(e.status).toBe("delivered");
  });

  it("ackEntryByIdForBoundAgents acks only entries in the supplied inbox set", async () => {
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const claimed = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    const entry = claimed[0];
    if (!entry) throw new Error("seed claim failed");

    // Wrong scope: an inboxId set that does NOT include the entry's owner —
    // server treats this as 'no-op', preventing one socket from acking
    // another agent's deliveries.
    const denied = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, ["inbox_other"]);
    expect(denied).toBeNull();

    const stillDelivered = await app.db.select().from(inboxEntries).where(eq(inboxEntries.id, entry.id));
    expect(stillDelivered[0]?.status).toBe("delivered");

    // Right scope: ack succeeds and flips status.
    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [a2.agent.inboxId]);
    expect(accepted).not.toBeNull();
    expect(accepted?.status).toBe("acked");
  });

  it("ackEntryByIdForBoundAgents accepts when the inbox list contains the owner alongside other inboxes", async () => {
    // Review issue #8c — covers the realistic shape: a socket has bound
    // multiple agents, and the inbox list passed to ack contains all of them.
    // SQL `inArray` is correct, but the test pins the invariant so a future
    // refactor that, say, accidentally compares only the first element is
    // caught immediately.
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const claimed = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    const entry = claimed[0];
    if (!entry) throw new Error("seed claim failed");

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [
      "inbox_other_a",
      a2.agent.inboxId,
      "inbox_other_b",
    ]);
    expect(accepted).not.toBeNull();
    expect(accepted?.status).toBe("acked");
    expect(accepted?.inboxId).toBe(a2.agent.inboxId);
  });

  it("ackEntryByIdForBoundAgents short-circuits on empty inbox list", async () => {
    const app = getApp();
    const res = await inboxService.ackEntryByIdForBoundAgents(app.db, 1, []);
    expect(res).toBeNull();
  });

  it("ackEntryByIdForBoundAgents returns null when an HTTP ack already flipped the row", async () => {
    // Pins the bug class behind the WS-push double-ack incident: if the
    // legacy HTTP ack runs first (`delivered → acked`), a follow-up WS ack
    // matches 0 rows and returns null. The SessionManager.ackEntry callback
    // must therefore ROUTE to exactly one channel — never both — otherwise
    // the server's per-agent in-flight counter (which only decrements on a
    // successful WS ack) leaks until push silently dies.
    //
    // This test exists to stop a future refactor from "helpfully" sending a
    // WS ack on top of HTTP (or vice-versa) without first reading why the
    // ackEntry callback exists.
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const claimed = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    const entry = claimed[0];
    if (!entry) throw new Error("seed claim failed");

    // Simulate the legacy HTTP ack path running first.
    await inboxService.ackEntry(app.db, entry.id, a2.agent.inboxId);

    // Now the WS-path ack arrives — must be a no-op (no double transition,
    // no error, just `null` so the caller can decline to decrement its
    // in-flight counter for a row it never moved).
    const wsAckResult = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [a2.agent.inboxId]);
    expect(wsAckResult).toBeNull();
  });
});
