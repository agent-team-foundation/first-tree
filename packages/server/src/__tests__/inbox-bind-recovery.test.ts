import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat } from "../services/chat.js";
import * as inboxService from "../services/inbox.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `resetDeliveredForInboxes` underpins the in-flight recovery path: at every
 * `agent:bind` we flip every still-`delivered` row back to `pending` so the
 * subsequent `claimBacklogForPush` re-includes them. The function MUST
 * touch only `delivered` rows in the supplied inbox set — bumping `pending`
 * to `pending` is a no-op SQL-wise but conceptually wrong, and overwriting
 * `acked` would re-deliver completed messages.
 *
 * See docs/inflight-message-recovery-design.md §4.
 */
describe("inbox bind-time recovery (resetDeliveredForInboxes)", () => {
  const getApp = useTestApp();

  it("resets only delivered rows in the supplied inbox set", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `bind-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `bind-a2-${uid}` });
    const a3 = await createTestAgent(app, { name: `bind-a3-${uid}` });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid, a3.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // Three explicit mentions of a2 → three notify=true entries on a2's inbox.
    for (let i = 0; i < 3; i++) {
      await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `msg ${i}`,
        receiverNames: [a2.agent.name],
      });
    }
    // One explicit mention of a3 → one notify=true entry on a3's inbox. This
    // row must NOT be touched when we only ask to reset a2's inbox.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "sibling message",
      receiverNames: [a3.agent.name],
    });

    // Claim → delivered. We need a mix of states in a2's inbox: pick the
    // first two via the WS-push claim helper (becomes `delivered`), leave
    // the third as `pending`, and force-set one row to `acked` to confirm
    // the WHERE filter actually short-circuits on status. Filter to
    // notify=true so the silent fan-out row (from the @a3 message) doesn't
    // skew the assertion — silent rows are context-only and are not part of
    // the bind-time notify recovery contract.
    const rows = await app.db
      .select({ id: inboxEntries.id, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)));
    expect(rows.length).toBe(3);
    const firstRow = rows[0];
    const secondRow = rows[1];
    const thirdRow = rows[2];
    if (!firstRow || !secondRow || !thirdRow) throw new Error("expected three notify rows");
    const claimedFirst = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, firstRow.messageId);
    const claimedSecond = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, secondRow.messageId);
    expect(claimedFirst).toHaveLength(1);
    expect(claimedSecond).toHaveLength(1);
    const claimedFirstRow = claimedFirst[0];
    const claimedSecondRow = claimedSecond[0];
    if (!claimedFirstRow || !claimedSecondRow) throw new Error("expected claimed inbox rows");

    // Mark `claimedSecond` as acked so we have all three statuses represented
    // for a2's inbox at the point of the reset call.
    await app.db.update(inboxEntries).set({ status: "acked" }).where(eq(inboxEntries.id, claimedSecondRow.id));

    // Drive the reset for a2's inbox only.
    const resetCount = await inboxService.resetDeliveredForInboxes(app.db, [a2.agent.inboxId]);
    // Only the still-delivered row (claimedFirst) should have flipped.
    expect(resetCount).toBe(1);

    const a2Final = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a2.agent.inboxId), eq(inboxEntries.notify, true)));
    const byId = new Map(a2Final.map((r) => [r.id, r.status]));
    expect(byId.get(claimedFirstRow.id)).toBe("pending"); // was delivered → reset
    expect(byId.get(claimedSecondRow.id)).toBe("acked"); // untouched
    expect(byId.get(thirdRow.id)).toBe("pending"); // was already pending

    // a3's mention row must be untouched by a reset that targeted only a2.
    // a3 received the dedicated @mention plus three silent fan-out rows from
    // the @a2 messages above (notify=false). The dedicated @mention is the
    // only notify=true row — all should be pending and unchanged.
    const a3Notify = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, a3.agent.inboxId), eq(inboxEntries.notify, true)));
    expect(a3Notify.length).toBe(1);
    expect(a3Notify[0]?.status).toBe("pending");
  });

  it("returns 0 on empty inbox list without hitting the DB", async () => {
    const app = getApp();
    const reset = await inboxService.resetDeliveredForInboxes(app.db, []);
    expect(reset).toBe(0);
  });

  it("returns 0 when no delivered rows match", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `bindnop-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `bindnop-a2-${uid}` });
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "no-op test",
      receiverNames: [a2.agent.name],
    });
    // Entry exists but is `pending`, not `delivered`.
    const reset = await inboxService.resetDeliveredForInboxes(app.db, [a2.agent.inboxId]);
    expect(reset).toBe(0);

    // Drain still picks the row up — proves reset is non-destructive.
    const drained = await inboxService.claimBacklogForPush(app.db, a2.agent.inboxId, 10);
    expect(drained.length).toBe(1);
  });

  it("retryCount stays unchanged across a reset — a crash is not a delivery attempt", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `bindrc-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `bindrc-a2-${uid}` });
    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;
    const msgRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "keep-retry",
      receiverNames: [a2.agent.name],
    });
    const messageId = msgRes.json().id;

    // Claim → delivered (retryCount stays 0 per the claim path).
    const claimed = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, messageId);
    expect(claimed).toHaveLength(1);
    const claimedRow = claimed[0];
    if (!claimedRow) throw new Error("expected claimed inbox row");

    const before = await app.db
      .select({ retryCount: inboxEntries.retryCount })
      .from(inboxEntries)
      .where(inArray(inboxEntries.id, [claimedRow.id]));
    expect(before[0]?.retryCount).toBe(0);

    const reset = await inboxService.resetDeliveredForInboxes(app.db, [a2.agent.inboxId]);
    expect(reset).toBe(1);

    const after = await app.db
      .select({ retryCount: inboxEntries.retryCount, status: inboxEntries.status })
      .from(inboxEntries)
      .where(inArray(inboxEntries.id, [claimedRow.id]));
    expect(after[0]?.status).toBe("pending");
    // Critical invariant: bind-time reset is NOT a retry bump. A flaky client
    // that crashes mid-turn must not push genuinely-stuck messages into
    // `failed` just because the recovery path ran.
    expect(after[0]?.retryCount).toBe(0);
  });
});

describe("inbox same-socket chat recovery", () => {
  const getApp = useTestApp();

  it("resets delivered rows for one chat and drains only that chat", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `recover-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `recover-a2-${uid}` });

    const chat1Res = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chat1Id = chat1Res.json().id;
    const chat2Res = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chat2Id = chat2Res.json().id;

    const msg1Res = await a1.request("POST", `/api/v1/agent/chats/${chat1Id}/messages`, {
      format: "text",
      content: "recover chat one",
      receiverNames: [a2.agent.name],
    });
    const msg2Res = await a1.request("POST", `/api/v1/agent/chats/${chat2Id}/messages`, {
      format: "text",
      content: "recover chat two",
      receiverNames: [a2.agent.name],
    });

    const claimed1 = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, msg1Res.json().id);
    expect(claimed1).toHaveLength(1);
    const claimed1Row = claimed1[0];
    if (!claimed1Row) throw new Error("expected claimed chat1 inbox row");

    const recovered = await inboxService.recoverUnackedForScope(app.db, {
      inboxId: a2.agent.inboxId,
      chatId: chat1Id,
    });
    expect(recovered.resetEntryIds).toEqual([claimed1Row.id]);

    const drained = await inboxService.claimBacklogForPushForChat(app.db, a2.agent.inboxId, chat1Id, 10);
    expect(drained.map((entry) => entry.id)).toEqual([claimed1Row.id]);

    const chat2Rows = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, a2.agent.inboxId),
          eq(inboxEntries.chatId, chat2Id),
          eq(inboxEntries.notify, true),
        ),
      );
    expect(chat2Rows).toHaveLength(1);
    expect(chat2Rows[0]?.messageId).toBe(msg2Res.json().id);
    expect(chat2Rows[0]?.status).toBe("pending");
  });

  it("redelivers the same silent preceding context after chat-scoped recovery", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `recoverctx-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `recoverctx-a-${uid}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });

    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "first recovered context" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "second recovered context" },
      { allowRecipientlessSend: true },
    );
    const trigger = await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "api",
      format: "text",
      content: "please recover this",
      metadata: { mentions: [observer.agent.uuid] },
    });

    const triggerEntryRows = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, observer.agent.inboxId),
          eq(inboxEntries.messageId, trigger.message.id),
          eq(inboxEntries.notify, true),
        ),
      );
    const triggerEntry = triggerEntryRows[0];
    if (!triggerEntry) throw new Error("expected trigger inbox row");

    const staleTriggerTime = new Date(Date.now() - (inboxService.PRECEDING_CONTEXT_WINDOW_SECONDS + 60) * 1000);
    const staleContextTime = new Date(staleTriggerTime.getTime() - 60 * 1000);
    await app.db
      .update(inboxEntries)
      .set({ createdAt: staleContextTime })
      .where(
        and(
          eq(inboxEntries.inboxId, observer.agent.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
        ),
      );
    await app.db.update(inboxEntries).set({ createdAt: staleTriggerTime }).where(eq(inboxEntries.id, triggerEntry.id));

    const claimed = await inboxService.claimAndBuildForPush(app.db, observer.agent.inboxId, trigger.message.id);
    const firstDelivery = claimed[0];
    if (!firstDelivery) throw new Error("expected first delivery");
    const firstPreceding = firstDelivery.message.precedingMessages.map((p) => p.content);
    expect(firstPreceding).toEqual(["first recovered context", "second recovered context"]);

    const silentAfterClaim = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, observer.agent.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
        ),
      );
    expect(silentAfterClaim.every((row) => row.status === "pending")).toBe(true);

    const recovered = await inboxService.recoverUnackedForScope(app.db, {
      inboxId: observer.agent.inboxId,
      chatId: chat.id,
    });
    expect(recovered.resetEntryIds).toEqual([firstDelivery.id]);

    const redelivered = await inboxService.claimBacklogForPushForChat(app.db, observer.agent.inboxId, chat.id, 10);
    const secondDelivery = redelivered[0];
    if (!secondDelivery) throw new Error("expected redelivery");
    expect(secondDelivery.id).toBe(firstDelivery.id);
    expect(secondDelivery.message.precedingMessages.map((p) => p.content)).toEqual(firstPreceding);
  });

  it("resets delivered rows across an inbox when no chat scope is supplied", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `recoverall-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `recoverall-a2-${uid}` });

    const chat1 = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chat2 = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const msg1 = await a1.request("POST", `/api/v1/agent/chats/${chat1.json().id}/messages`, {
      format: "text",
      content: "recover all one",
      receiverNames: [a2.agent.name],
    });
    const msg2 = await a1.request("POST", `/api/v1/agent/chats/${chat2.json().id}/messages`, {
      format: "text",
      content: "recover all two",
      receiverNames: [a2.agent.name],
    });

    const first = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, msg1.json().id);
    const second = await inboxService.claimAndBuildForPush(app.db, a2.agent.inboxId, msg2.json().id);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const recovered = await inboxService.recoverUnackedForScope(app.db, { inboxId: a2.agent.inboxId });
    expect(recovered.resetEntryIds.sort((a, b) => a - b)).toEqual(
      [first[0]?.id, second[0]?.id].filter((id): id is number => typeof id === "number").sort((a, b) => a - b),
    );
  });

  it("prunes acked silent rows and stale pending silent rows", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `prunesilent-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `prunesilent-a-${uid}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });

    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "acked silent" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chat.id,
      human.agent.uuid,
      { source: "api", format: "text", content: "stale pending silent" },
      { allowRecipientlessSend: true },
    );

    const silentRows = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, observer.agent.inboxId), eq(inboxEntries.notify, false)));
    expect(silentRows).toHaveLength(2);
    const [acked, stale] = silentRows;
    if (!acked || !stale) throw new Error("expected two silent rows");
    await app.db.update(inboxEntries).set({ status: "acked" }).where(eq(inboxEntries.id, acked.id));
    await app.db
      .update(inboxEntries)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(inboxEntries.id, stale.id));

    await expect(inboxService.pruneStaleSilentEntries(app.db, 60)).resolves.toEqual({
      ackedDeleted: 1,
      stalePendingDeleted: 1,
    });
  });

  it("assertInboxOwner rejects cross-inbox access", async () => {
    await expect(inboxService.assertInboxOwner("inbox-a", "inbox-b")).rejects.toThrow(/another agent/i);
    await expect(inboxService.assertInboxOwner("inbox-a", "inbox-a")).resolves.toBeUndefined();
  });
});
