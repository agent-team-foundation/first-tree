import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import * as inboxService from "../services/inbox.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Preceding-context assembly is built from one set-based statement rather than
 * one query per claimed trigger. The invariants below are the ones a batched
 * implementation can silently break while single-trigger tests stay green:
 * per-trigger window boundaries inside a single drain, chat partitioning,
 * and the ordering contract.
 */
describe("batched preceding-context assembly", () => {
  const getApp = useTestApp();

  async function seedChatWithObserver(app: FastifyInstance, uid: string) {
    const human = await createTestAgent(app, { type: "human", name: `pcb-h-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `pcb-obs-${uid}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });
    return { human, observer, chat };
  }

  /** Message nobody is addressed in — lands as a silent (notify=false) row. */
  async function sendSilent(app: FastifyInstance, chatId: string, senderId: string, content: string) {
    return sendMessage(
      app.db,
      chatId,
      senderId,
      { source: "api", format: "text", content },
      { allowRecipientlessSend: true },
    );
  }

  /** Message that @mentions the observer — lands as a notify=true trigger. */
  async function sendTrigger(
    app: FastifyInstance,
    chatId: string,
    senderId: string,
    observerId: string,
    content: string,
  ) {
    return sendMessage(app.db, chatId, senderId, {
      source: "api",
      format: "text",
      content,
      metadata: { mentions: [observerId] },
    });
  }

  function precedingContents(delivery: { message: { precedingMessages: Array<{ content: unknown }> } }): unknown[] {
    return delivery.message.precedingMessages.map((p) => p.content);
  }

  it("gives each trigger in one drain its own window instead of a shared lower bound", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await seedChatWithObserver(app, uid);

    // silent-a | T1 | silent-b | T2 | silent-c | T3 — all claimed in one drain.
    await sendSilent(app, chat.id, human.agent.uuid, "silent-a");
    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "trigger-1");
    await sendSilent(app, chat.id, human.agent.uuid, "silent-b");
    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "trigger-2");
    await sendSilent(app, chat.id, human.agent.uuid, "silent-c");
    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "trigger-3");

    const claimed = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
    expect(claimed.map((entry) => entry.message.content)).toEqual(["trigger-1", "trigger-2", "trigger-3"]);

    // A shared lower bound would leak earlier silent rows into later triggers.
    expect(claimed.map(precedingContents)).toEqual([["silent-a"], ["silent-b"], ["silent-c"]]);
  });

  it("keeps per-chat windows separate when one drain spans several chats", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const human = await createTestAgent(app, { type: "human", name: `pcb-mh-${uid}` });
    const observer = await createTestAgent(app, { type: "agent", name: `pcb-mobs-${uid}` });
    const chatOne = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });
    const chatTwo = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [observer.agent.uuid],
    });

    await sendSilent(app, chatOne.id, human.agent.uuid, "one-silent");
    await sendSilent(app, chatTwo.id, human.agent.uuid, "two-silent");
    await sendTrigger(app, chatOne.id, human.agent.uuid, observer.agent.uuid, "one-trigger");
    await sendTrigger(app, chatTwo.id, human.agent.uuid, observer.agent.uuid, "two-trigger");

    const claimed = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
    const byContent = new Map(claimed.map((entry) => [entry.message.content, entry]));

    const one = byContent.get("one-trigger");
    const two = byContent.get("two-trigger");
    if (!one || !two) throw new Error("expected both chat triggers in one drain");
    // Chat two's silent row sits between chat one's silent row and its
    // trigger by inbox id, so an unpartitioned window would capture it.
    expect(precedingContents(one)).toEqual(["one-silent"]);
    expect(precedingContents(two)).toEqual(["two-silent"]);
  });

  it("orders preceding context by message time, not by inbox row order", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await seedChatWithObserver(app, uid);

    const first = await sendSilent(app, chat.id, human.agent.uuid, "written-first");
    const second = await sendSilent(app, chat.id, human.agent.uuid, "written-second");
    const third = await sendSilent(app, chat.id, human.agent.uuid, "written-third");

    // Make message chronology disagree with inbox insertion order: the row
    // written second is now the oldest message. Ordering by the inbox row
    // would return written-first/second/third; ordering by message time —
    // the actual contract — returns written-second/first/third.
    const base = Date.now() - 60_000;
    await app.db
      .update(messages)
      .set({ createdAt: new Date(base) })
      .where(eq(messages.id, second.message.id));
    await app.db
      .update(messages)
      .set({ createdAt: new Date(base + 1_000) })
      .where(eq(messages.id, first.message.id));
    await app.db
      .update(messages)
      .set({ createdAt: new Date(base + 2_000) })
      .where(eq(messages.id, third.message.id));

    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "order-trigger");

    const claimed = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
    const delivery = claimed[0];
    if (!delivery) throw new Error("expected trigger delivery");
    expect(precedingContents(delivery)).toEqual(["written-second", "written-first", "written-third"]);
    // Rendered timestamps must stay ISO 8601 — the statement formats them in
    // SQL because a raw execute returns PostgreSQL's own text form.
    for (const preceding of delivery.message.precedingMessages) {
      expect(preceding.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("closes the window at an already-acked earlier notify row", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await seedChatWithObserver(app, uid);

    await sendSilent(app, chat.id, human.agent.uuid, "before-acked-trigger");
    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "acked-trigger");

    const firstClaim = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
    const firstDelivery = firstClaim[0];
    if (!firstDelivery) throw new Error("expected first delivery");
    const acked = await inboxService.ackEntryByIdForBoundAgents(app.db, firstDelivery.id, [observer.agent.inboxId]);
    expect(acked.ok).toBe(true);

    await sendSilent(app, chat.id, human.agent.uuid, "after-acked-trigger");
    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "second-trigger");

    const secondClaim = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
    const secondDelivery = secondClaim[0];
    if (!secondDelivery) throw new Error("expected second delivery");
    // The bound query has no status filter on purpose: an acked notify row
    // still closes the window, so the pre-trigger silent row stays out.
    expect(precedingContents(secondDelivery)).toEqual(["after-acked-trigger"]);
  });

  it("skips rows with no chat while still bundling chat-scoped triggers", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await seedChatWithObserver(app, uid);

    await sendSilent(app, chat.id, human.agent.uuid, "scoped-silent");
    const trigger = await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "scoped-trigger");

    // A legacy null-chat row claimed in the same drain must not break the
    // batch, and must carry no context of its own.
    await app.db.insert(inboxEntries).values({
      inboxId: observer.agent.inboxId,
      messageId: trigger.message.id,
      chatId: null,
      status: "pending",
      notify: true,
    });

    const claimed = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
    expect(claimed).toHaveLength(2);
    const scoped = claimed.find((entry) => entry.chatId === chat.id);
    const unscoped = claimed.find((entry) => entry.chatId === null);
    if (!scoped || !unscoped) throw new Error("expected both scoped and null-chat entries");
    expect(precedingContents(scoped)).toEqual(["scoped-silent"]);
    expect(unscoped.message.precedingMessages).toEqual([]);
  });

  it("issues the same number of queries no matter how many triggers a drain claims", async () => {
    const app = getApp();

    async function drainAndCount(triggerCount: number): Promise<{ execute: number; select: number }> {
      const uid = crypto.randomUUID().slice(0, 6);
      const { human, observer, chat } = await seedChatWithObserver(app, uid);
      for (let i = 0; i < triggerCount; i++) {
        await sendSilent(app, chat.id, human.agent.uuid, `silent-${i}`);
        await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, `trigger-${i}`);
      }

      const probe = countingDb(app.db);
      const claimed = await inboxService.claimBacklogForPush(probe.db, observer.agent.inboxId, 50);
      expect(claimed).toHaveLength(triggerCount);
      expect(claimed.map(precedingContents)).toEqual(Array.from({ length: triggerCount }, (_, i) => [`silent-${i}`]));
      return probe.counts();
    }

    const small = await drainAndCount(2);
    const large = await drainAndCount(8);

    // Counting both statement kinds matters: `execute` alone would still read
    // as 1 if someone reintroduced a per-trigger `select` alongside the
    // batched statement.
    expect(large).toEqual(small);
    // The batched preceding-context query is the only raw statement on this
    // path. The per-trigger loop this replaced would report `triggerCount`.
    expect(large.execute).toBe(1);
  });

  it("skips silent rows another transaction holds instead of blocking on them", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { human, observer, chat } = await seedChatWithObserver(app, uid);

    const held = await sendSilent(app, chat.id, human.agent.uuid, "held-silent");
    await sendSilent(app, chat.id, human.agent.uuid, "free-silent");
    await sendTrigger(app, chat.id, human.agent.uuid, observer.agent.uuid, "concurrent-trigger");

    const [heldRow] = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, observer.agent.inboxId), eq(inboxEntries.messageId, held.message.id)))
      .orderBy(asc(inboxEntries.id))
      .limit(1);
    if (!heldRow) throw new Error("expected the silent row to exist");

    // Hold a row lock in a parallel transaction, then drain. SKIP LOCKED must
    // step over the held row and still return promptly.
    let releaseLock: () => void = () => {};
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHeld = new Promise<void>((resolve, reject) => {
      app.db
        .transaction(async (tx) => {
          await tx.select().from(inboxEntries).where(eq(inboxEntries.id, heldRow.id)).for("update");
          resolve();
          await lockReleased;
        })
        .catch(reject);
    });
    await lockHeld;

    try {
      const claimed = await inboxService.claimBacklogForPush(app.db, observer.agent.inboxId, 10);
      const delivery = claimed[0];
      if (!delivery) throw new Error("expected trigger delivery");
      expect(precedingContents(delivery)).toEqual(["free-silent"]);
    } finally {
      releaseLock();
    }
  });
});

/**
 * Wrap a database so statements issued inside a delivery transaction can be
 * counted. Both `execute` and `select` are tracked — counting only raw
 * statements would miss a per-trigger `select` reintroduced next to the
 * batched one.
 *
 * The casts are unavoidable: Drizzle's transaction callback is generically
 * typed over the schema, and a `Proxy` cannot preserve that relationship. The
 * proxy only intercepts `transaction`, `execute`, and `select`, forwarding
 * everything else untouched, so runtime behaviour is identical.
 */
function countingDb(db: FastifyInstance["db"]): {
  db: FastifyInstance["db"];
  counts: () => { execute: number; select: number };
} {
  const tally = { execute: 0, select: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return (callback: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
        target.transaction(
          async (tx) => {
            const txProxy = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                const value = Reflect.get(txTarget, txProp, txReceiver);
                const counted = txProp === "execute" || txProp === "select";
                if (!counted || typeof value !== "function") return value;
                return (...args: unknown[]) => {
                  tally[txProp] += 1;
                  return value.apply(txTarget, args);
                };
              },
            });
            return callback(txProxy);
          },
          // biome-ignore lint/suspicious/noExplicitAny: Proxy cannot carry Drizzle's schema-generic transaction signature
          ...(rest as any),
        );
    },
  });
  return { db: wrapped, counts: () => ({ ...tally }) };
}
