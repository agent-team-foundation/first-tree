import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createAgent, getAgent } from "../services/agent.js";
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
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;
    // Agent endpoint enforces explicit routing; the claim helpers
    // operate on `pending` notify=true rows, so declare a2 explicitly.
    const msgRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "WS push test",
      receiverNames: [a2.agent.name],
    });
    return { a2, messageId: msgRes.json().id, chatId };
  }

  async function seedDeliverables(app: FastifyInstance, count: number) {
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `wspm-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `wspm-a2-${uid}` });
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;
    const messageIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const msgRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `WS push test ${i}`,
        receiverNames: [a2.agent.name],
      });
      messageIds.push(msgRes.json().id);
    }
    const rows = await app.db
      .select()
      .from(inboxEntries)
      .where(
        and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)),
      )
      .orderBy(asc(inboxEntries.id));
    return { a2, chatId, messageIds, rows };
  }

  async function seedDeliverablesAcrossChats(app: FastifyInstance, messagesPerChat: number[]) {
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `wspf-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `wspf-a2-${uid}` });
    const chatIds: string[] = [];
    for (const [chatIndex, count] of messagesPerChat.entries()) {
      const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.agent.uuid],
      });
      const chatId = chatRes.json().id;
      chatIds.push(chatId);
      for (let i = 0; i < count; i++) {
        await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
          format: "text",
          content: `chat ${chatIndex} msg ${i}`,
          receiverNames: [a2.agent.name],
        });
      }
    }
    return { a2, chatIds };
  }

  async function loadSilentRows(app: FastifyInstance, inboxId: string, chatId: string) {
    return app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, false)))
      .orderBy(asc(inboxEntries.id));
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
    // Same wire shape as the `pollInbox` path → client-side dispatch is
    // identical (single SessionManager.dispatch call site).
    expect(typeof entry.message.configVersion).toBe("number");
    expect(entry.message.recipientMode).toBeTruthy();
    // `inbox_entries.id` is bigserial (int8) — postgres-js returns int8 as a
    // JS string by default. The raw-SQL claim path has to coerce to number
    // because the WS push frame schema validates `entryId: z.number()`.
    // Without coercion the client drops every push frame as malformed.
    expect(typeof entry.id).toBe("number");
  });

  it("returns an empty array on a second claim of the same (inbox, message) — race-safe with the debug GET /inbox path", async () => {
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const first = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    expect(first).toHaveLength(1);

    // Second claim hits no `pending` row — push path must surface that as
    // `[]`, NOT throw, otherwise a NOTIFY storm crashes the LISTEN loop.
    const second = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    expect(second).toEqual([]);
  });

  it("claimAndBuildForPush claims the same-chat pending prefix through a newer target", async () => {
    const app = getApp();
    const { a2, messageIds, rows } = await seedDeliverables(app, 2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two inbox rows");

    const claimed = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageIds[1] ?? "");
    expect(claimed.map((entry) => entry.id)).toEqual([first.id, second.id]);

    const after = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)))
      .orderBy(asc(inboxEntries.id));
    expect(after.map((row) => [row.id, row.status])).toEqual([
      [first.id, "delivered"],
      [second.id, "delivered"],
    ]);
  });

  it("claimAndBuildForPush bundles silent context, then ACK-through drains it", async () => {
    // Mirror the silent-inbox-context test but on the push path. This is the
    // riskiest piece of the refactor — `bundleDeliveryWithSilentContext` was
    // extracted from `pollInboxInner` to be shared, so a divergence between
    // poll and push silent-context handling would be a silent regression.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const ctx = await createAdminContext(app, { username: `wsp-si-${uid}` });
    const human = await getAgent(app.db, ctx.humanAgentUuid);
    if (!human) throw new Error("expected admin human mirror");
    const observer = await createAgent(app.db, {
      name: `wsp-si-obs-${uid}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const peer = await createAgent(app.db, {
      name: `wsp-si-peer-${uid}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, human.uuid, {
      type: "group",
      participantIds: [observer.uuid, peer.uuid],
    });
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, observer.uuid)));

    // Three silent messages (no mentions → silent context rows), then a
    // trigger that explicitly mentions observer.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      { source: "api", format: "text", content: "first silent" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      { source: "api", format: "text", content: "second silent" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      { source: "api", format: "text", content: "third silent" },
      { allowRecipientlessSend: true },
    );
    const trigger = await sendMessage(app.db, chat.id, human.uuid, {
      source: "api",
      format: "text",
      content: "please weigh in",
      metadata: { mentions: [observer.uuid] },
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
    expect(entry.message.precedingMessages.map((p) => p.source)).toEqual(["api", "api", "api"]);

    // Bundling is not consumption: same-socket recovery can still rebuild
    // the preceding block until the notify trigger is ACKed.
    const silentBeforeAck = await loadSilentRows(app, observer.inboxId, chat.id);
    expect(silentBeforeAck.length).toBeGreaterThan(0);
    expect(silentBeforeAck.every((r) => r.status === "pending")).toBe(true);

    const acked = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [observer.inboxId]);
    expect(acked.ok).toBe(true);
    if (!acked.ok) throw new Error("ack-through unexpectedly rejected");
    expect(acked.ackedCount).toBe(1);
    expect(acked.ackedEntryIds).toEqual([entry.id]);

    const silentAfterAck = await loadSilentRows(app, observer.inboxId, chat.id);
    expect(silentAfterAck.every((r) => r.status === "acked")).toBe(true);
  });

  it("ack-through drains silent rows only in the same inbox/chat up to the notify cursor", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `scope-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `scope-obs-${uid}` });
    const peer = await createTestAgent(app, { type: "agent", name: `scope-peer-${uid}` });

    const chat1 = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid, peer.agent.uuid],
    });
    const chat2 = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid, peer.agent.uuid],
    });

    await sendMessage(
      app.db,
      chat1.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "old chat1 context" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chat2.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "old chat2 context" },
      { allowRecipientlessSend: true },
    );
    const trigger = await sendMessage(app.db, chat1.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "observer trigger",
      metadata: { mentions: [observer.agent.uuid] },
    });

    const claimed = await inboxService.claimAndBuildForPush(app.db, observer.agent.inboxId, trigger.message.id);
    const entry = claimed[0];
    if (!entry) throw new Error("expected trigger claim");

    await sendMessage(
      app.db,
      chat1.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "later chat1 context" },
      { allowRecipientlessSend: true },
    );

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [observer.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.ackedEntryIds).toEqual([entry.id]);

    const observerChat1 = await loadSilentRows(app, observer.agent.inboxId, chat1.id);
    expect(observerChat1.some((row) => row.id < entry.id && row.status === "acked")).toBe(true);
    expect(observerChat1.some((row) => row.id > entry.id && row.status === "pending")).toBe(true);

    const observerChat2 = await loadSilentRows(app, observer.agent.inboxId, chat2.id);
    expect(observerChat2.length).toBeGreaterThan(0);
    expect(observerChat2.every((row) => row.status === "pending")).toBe(true);

    const peerChat1 = await loadSilentRows(app, peer.agent.inboxId, chat1.id);
    expect(peerChat1.length).toBeGreaterThan(0);
    expect(peerChat1.every((row) => row.status === "pending")).toBe(true);
  });

  it("does not reuse silent context that belongs before an earlier unacked notify trigger", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `part-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `part-obs-${uid}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });

    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "before first trigger" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "first trigger",
      metadata: { mentions: [observer.agent.uuid] },
    });

    const firstClaim = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 1);
    const firstDelivery = firstClaim[0];
    if (!firstDelivery) throw new Error("expected first delivery");
    expect(firstDelivery.message.precedingMessages.map((p) => p.content)).toEqual(["before first trigger"]);

    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "between triggers" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "second trigger",
      metadata: { mentions: [observer.agent.uuid] },
    });

    const secondClaim = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 1);
    const secondDelivery = secondClaim[0];
    if (!secondDelivery) throw new Error("expected second delivery");
    expect(secondDelivery.message.precedingMessages.map((p) => p.content)).toEqual(["between triggers"]);

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, secondDelivery.id, [observer.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.ackedEntryIds).toEqual([firstDelivery.id, secondDelivery.id]);

    const afterAck = await loadSilentRows(app, observer.agent.inboxId, chat.id);
    expect(afterAck.map((row) => row.status)).toEqual(["acked", "acked"]);
  });

  it("ack-through drains silent rows excluded from preceding context by cap or trigger-relative window", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `cap-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `cap-obs-${uid}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });

    const total = inboxService.PRECEDING_CONTEXT_MAX_ENTRIES + 2;
    for (let i = 0; i < total; i++) {
      await sendMessage(
        app.db,
        chat.id,
        human.agent.uuid,
        { source: "api", format: "text", content: `silent-${i}` },
        { allowRecipientlessSend: true },
      );
    }

    const silentRows = await loadSilentRows(app, observer.agent.inboxId, chat.id);
    expect(silentRows).toHaveLength(total);
    const oldExcluded = silentRows[0];
    if (!oldExcluded) throw new Error("expected silent rows");
    await app.db
      .update(inboxEntries)
      .set({ createdAt: new Date(Date.now() - (inboxService.PRECEDING_CONTEXT_WINDOW_SECONDS + 60) * 1000) })
      .where(eq(inboxEntries.id, oldExcluded.id));

    const trigger = await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "cap trigger",
      metadata: { mentions: [observer.agent.uuid] },
    });

    const claimed = await inboxService.claimAndBuildForPush(app.db, observer.agent.inboxId, trigger.message.id);
    const entry = claimed[0];
    if (!entry) throw new Error("expected trigger claim");
    expect(entry.message.precedingMessages).toHaveLength(inboxService.PRECEDING_CONTEXT_MAX_ENTRIES);
    const precedingContents = entry.message.precedingMessages.map((p) => p.content);
    expect(precedingContents).not.toContain("silent-0");
    expect(precedingContents).not.toContain("silent-1");
    expect(precedingContents).toContain(`silent-${total - 1}`);

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [observer.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.ackedCount).toBe(1);
    expect(accepted.ackedEntryIds).toEqual([entry.id]);

    const afterAck = await loadSilentRows(app, observer.agent.inboxId, chat.id);
    expect(afterAck).toHaveLength(total);
    expect(afterAck.every((row) => row.status === "acked")).toBe(true);
  });

  it("claimBacklogForPush drains pending entries by inbox id up to the limit", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `wspb-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `wspb-a2-${uid}` });
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // Each backlog message must declare a2 explicitly so it lands as a
    // notify=true pending row that the backlog claim drains.
    for (let i = 0; i < 3; i++) {
      await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `msg ${i}`,
        receiverNames: [a2.agent.name],
      });
    }

    const drained = await inboxService.claimBacklogForPush(app.db, a2.agent.inboxId, 10);
    expect(drained.length).toBe(3);
    expect(drained.map((entry) => entry.id)).toEqual([...drained].map((entry) => entry.id).sort((a, b) => a - b));
    // Every drained entry must be marked delivered atomically with the claim.
    for (const e of drained) expect(e.status).toBe("delivered");
    // Pin the bigserial → number conversion on the backlog path too. The WS
    // push frame schema validates `entryId: z.number()`; if `claimBacklog`
    // ever regresses to raw SQL, every push frame would be dropped client-
    // side as malformed. See issue #194.
    for (const e of drained) expect(typeof e.id).toBe("number");
  });

  it("claimBacklogForPushFair limits a single chat to its per-chat budget", async () => {
    const app = getApp();
    const { a2, chatId } = await seedDeliverables(app, 12);

    const drained = await inboxService.claimBacklogForPushFair(app.db, a2.agent.inboxId, {
      limit: 50,
      defaultPerChatLimit: 8,
      chatBudgets: [],
    });

    expect(drained).toHaveLength(8);
    expect(drained.every((entry) => entry.chatId === chatId)).toBe(true);
    expect(drained.map((entry) => entry.id)).toEqual([...drained].map((entry) => entry.id).sort((a, b) => a - b));

    const rows = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)),
      )
      .orderBy(asc(inboxEntries.id));
    expect(rows.filter((row) => row.status === "delivered")).toHaveLength(8);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(4);
  });

  it("claimBacklogForPushFair skips a capped chat while claiming another eligible chat", async () => {
    const app = getApp();
    const { a2, chatIds } = await seedDeliverablesAcrossChats(app, [3, 2]);
    const cappedChatId = chatIds[0];
    const eligibleChatId = chatIds[1];
    if (!cappedChatId || !eligibleChatId) throw new Error("expected two chats");

    const drained = await inboxService.claimBacklogForPushFair(app.db, a2.agent.inboxId, {
      limit: 10,
      defaultPerChatLimit: 2,
      chatBudgets: [{ chatId: cappedChatId, remaining: 0 }],
    });

    expect(drained).toHaveLength(2);
    expect(drained.every((entry) => entry.chatId === eligibleChatId)).toBe(true);

    const cappedRows = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, a2.agent.inboxId),
          eq(inboxEntries.chatId, cappedChatId),
          eq(inboxEntries.notify, true),
        ),
      );
    expect(cappedRows.every((row) => row.status === "pending")).toBe(true);
  });

  it("claimBacklogForPushFair fills post-ack budget across eligible chats", async () => {
    const app = getApp();
    const { a2, chatIds } = await seedDeliverablesAcrossChats(app, [3, 3]);
    const ackedChatId = chatIds[0];
    const otherChatId = chatIds[1];
    if (!ackedChatId || !otherChatId) throw new Error("expected two chats");

    const drained = await inboxService.claimBacklogForPushFair(app.db, a2.agent.inboxId, {
      limit: 3,
      defaultPerChatLimit: 2,
      chatBudgets: [{ chatId: ackedChatId, remaining: 1 }],
    });

    expect(drained).toHaveLength(3);
    expect(drained.filter((entry) => entry.chatId === ackedChatId)).toHaveLength(1);
    expect(drained.filter((entry) => entry.chatId === otherChatId)).toHaveLength(2);
  });

  it("claimBacklogForPushFair bundles silent context without spending extra per-chat slots", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `fairctx-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `fairctx-a-${uid}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });

    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "silent one" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "silent two" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "notify one",
      metadata: { mentions: [observer.agent.uuid] },
    });
    await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "notify two",
      metadata: { mentions: [observer.agent.uuid] },
    });

    const drained = await inboxService.claimBacklogForPushFair(app.db, observer.agent.inboxId, {
      limit: 50,
      defaultPerChatLimit: 1,
      chatBudgets: [],
    });

    expect(drained).toHaveLength(1);
    const entry = drained[0];
    if (!entry) throw new Error("expected fair delivery");
    expect(entry.message.content).toBe("notify one");
    expect(entry.message.precedingMessages.map((p) => p.content)).toEqual(["silent one", "silent two"]);

    const silentRows = await loadSilentRows(app, observer.agent.inboxId, chat.id);
    expect(silentRows.every((row) => row.status === "pending")).toBe(true);
  });

  it("uses inbox id cursor order even when createdAt is reversed", async () => {
    const app = getApp();
    const { a2, rows } = await seedDeliverables(app, 2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two inbox rows");

    await app.db
      .update(inboxEntries)
      .set({ createdAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(inboxEntries.id, first.id));
    await app.db
      .update(inboxEntries)
      .set({ createdAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(inboxEntries.id, second.id));

    const drained = await inboxService.claimBacklogForPush(app.db, a2.agent.inboxId, 10);
    expect(drained.map((entry) => entry.id)).toEqual([first.id, second.id]);

    const firstAck = await inboxService.ackEntryByIdForBoundAgents(app.db, first.id, [a2.agent.inboxId]);
    expect(firstAck.ok).toBe(true);
    if (!firstAck.ok) throw new Error("ack-through unexpectedly rejected");
    expect(firstAck.ackedEntryIds).toEqual([first.id]);

    const afterFirstAck = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)))
      .orderBy(asc(inboxEntries.id));
    expect(afterFirstAck.map((row) => [row.id, row.status])).toEqual([
      [first.id, "acked"],
      [second.id, "delivered"],
    ]);

    const secondAck = await inboxService.ackEntryByIdForBoundAgents(app.db, second.id, [a2.agent.inboxId]);
    expect(secondAck.ok).toBe(true);
    if (!secondAck.ok) throw new Error("ack-through unexpectedly rejected");
    expect(secondAck.ackedEntryIds).toEqual([second.id]);
  });

  it("ackEntryByIdForBoundAgents commits delivered notify=true prefix through the target entry", async () => {
    const app = getApp();
    const { a2, messageIds, rows } = await seedDeliverables(app, 2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two inbox rows");

    await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageIds[0] ?? "");
    await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageIds[1] ?? "");

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, second.id, [a2.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.disposition).toBe("acked");
    expect(accepted.ackedCount).toBe(2);
    expect(accepted.ackedEntryIds).toEqual([first.id, second.id]);
    expect(accepted.throughEntry.id).toBe(second.id);

    const after = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)))
      .orderBy(asc(inboxEntries.id));
    expect(after.map((row) => [row.id, row.status])).toEqual([
      [first.id, "acked"],
      [second.id, "acked"],
    ]);
  });

  it("ackEntryByIdForBoundAgents accepts delivered rows reset to pending by recovery", async () => {
    const app = getApp();
    const { a2, messageIds, rows } = await seedDeliverables(app, 2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two inbox rows");

    await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageIds[0] ?? "");
    await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageIds[1] ?? "");
    await app.db
      .update(inboxEntries)
      .set({ status: "pending" })
      .where(inArray(inboxEntries.id, [first.id, second.id]));

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, second.id, [a2.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.disposition).toBe("accepted_from_pending");
    expect(accepted.ackedCount).toBe(2);
    expect(accepted.ackedEntryIds).toEqual([first.id, second.id]);

    const after = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)))
      .orderBy(asc(inboxEntries.id));
    expect(after.map((row) => [row.id, row.status])).toEqual([
      [first.id, "acked"],
      [second.id, "acked"],
    ]);
  });

  it("ackEntryByIdForBoundAgents rejects an ack-through when an earlier notify=true row is pending", async () => {
    const app = getApp();
    const { a2, rows } = await seedDeliverables(app, 2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two inbox rows");

    await app.db
      .update(inboxEntries)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(inboxEntries.id, second.id));

    const rejected = await inboxService.ackEntryByIdForBoundAgents(app.db, second.id, [a2.agent.inboxId]);
    expect(rejected).toEqual({ ok: false, reason: "prefix_gap" });

    const after = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)))
      .orderBy(asc(inboxEntries.id));
    expect(after.map((row) => [row.id, row.status])).toEqual([
      [first.id, "pending"],
      [second.id, "delivered"],
    ]);
  });

  it("ackEntryByIdForBoundAgents commits only delivered rows after an already-acked prefix", async () => {
    const app = getApp();
    const { a2, messageIds, rows } = await seedDeliverables(app, 2);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two inbox rows");

    await app.db
      .update(inboxEntries)
      .set({ status: "acked", ackedAt: new Date() })
      .where(eq(inboxEntries.id, first.id));
    await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageIds[1] ?? "");

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, second.id, [a2.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.ackedCount).toBe(1);
    expect(accepted.ackedEntryIds).toEqual([second.id]);
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
    expect(denied).toEqual({ ok: false, reason: "not_found_or_not_bound" });

    const stillDelivered = await app.db.select().from(inboxEntries).where(eq(inboxEntries.id, entry.id));
    expect(stillDelivered[0]?.status).toBe("delivered");

    // Right scope: ack succeeds and flips status.
    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [a2.agent.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack unexpectedly rejected");
    expect(accepted.disposition).toBe("acked");
    expect(accepted.ackedCount).toBe(1);
    expect(accepted.throughEntry.status).toBe("acked");
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
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack unexpectedly rejected");
    expect(accepted.throughEntry.status).toBe("acked");
    expect(accepted.throughEntry.inboxId).toBe(a2.agent.inboxId);
  });

  it("ackEntryByIdForBoundAgents accepts duplicate ACKs idempotently", async () => {
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const claimed = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    const entry = claimed[0];
    if (!entry) throw new Error("seed claim failed");

    const first = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [a2.agent.inboxId]);
    expect(first.ok).toBe(true);

    const second = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [a2.agent.inboxId]);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("duplicate ack unexpectedly rejected");
    expect(second.disposition).toBe("already_acked");
    expect(second.ackedCount).toBe(0);
    expect(second.throughEntry.status).toBe("acked");
  });

  it("ackEntryByIdForBoundAgents rejects an owned pending row as a prefix gap", async () => {
    const app = getApp();
    const { a2, messageId } = await seedDeliverable(app);

    const [entry] = await app.db.select().from(inboxEntries).where(eq(inboxEntries.messageId, messageId)).limit(1);
    if (!entry) throw new Error("seed entry missing");
    expect(entry.status).toBe("pending");

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [a2.agent.inboxId]);
    expect(accepted).toEqual({ ok: false, reason: "prefix_gap" });
  });

  it("ackEntryByIdForBoundAgents short-circuits on empty inbox list", async () => {
    const app = getApp();
    const res = await inboxService.ackEntryByIdForBoundAgents(app.db, 1, []);
    expect(res).toEqual({ ok: false, reason: "not_found_or_not_bound" });
  });
});
