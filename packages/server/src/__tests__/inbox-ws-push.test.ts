import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
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
      type: "group",
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
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, observer.uuid)));

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
      type: "group",
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
    // Pin the bigserial → number conversion on the backlog path too. The WS
    // push frame schema validates `entryId: z.number()`; if `claimBacklog`
    // ever regresses to raw SQL, every push frame would be dropped client-
    // side as malformed. See issue #194.
    for (const e of drained) expect(typeof e.id).toBe("number");
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
});
