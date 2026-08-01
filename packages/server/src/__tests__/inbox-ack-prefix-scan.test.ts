import { INBOX_ENTRY_STATUSES, inboxEntryStatusSchema } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import * as schema from "../db/schema/index.js";
import { messages } from "../db/schema/messages.js";
import * as inboxService from "../services/inbox.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Guards for the ACK-through prefix scan (PERF-008 / #1671).
 *
 * The scan used to read every notify=true row in the `(inbox_id, chat_id)`
 * partition below the cursor, including rows acked long ago, making a single
 * ACK cost O(chat history). These tests pin the two properties that keep it
 * bounded, plus the `chat_id IS NULL` branch that the existing ACK coverage
 * does not reach.
 */
describe("inbox ACK prefix scan", () => {
  const getApp = useTestApp();

  /** Create a chat between two agents and bulk-seed `history` acked rows for
   *  the recipient, followed by `live` delivered rows it can still ACK. */
  async function seedHistory(
    app: FastifyInstance,
    opts: { history: number; live: number; nullChat?: boolean },
  ): Promise<{ inboxId: string; chatId: string; liveIds: number[] }> {
    const uid = crypto.randomUUID().slice(0, 8);
    const sender = await createTestAgent(app, { name: `ack-s-${uid}` });
    const recipient = await createTestAgent(app, { name: `ack-r-${uid}` });
    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [recipient.agent.uuid],
    });
    const chatId: string = chatRes.json().id;
    const inboxId = recipient.agent.inboxId;
    const total = opts.history + opts.live;

    // Bulk-insert rather than sending `total` real messages: this exercises the
    // ACK read path, and the fan-out path has its own coverage elsewhere.
    const messageRows = Array.from({ length: total }, (_, i) => ({
      id: `ack-msg-${uid}-${i}`,
      chatId,
      senderId: sender.agent.uuid,
      format: "text",
      content: `seed ${i}`,
      source: "api" as const,
    }));
    await app.db.insert(messages).values(messageRows);
    await app.db.insert(inboxEntries).values(
      messageRows.map((m, i) => ({
        inboxId,
        messageId: m.id,
        chatId: opts.nullChat ? null : chatId,
        notify: true,
        status: i < opts.history ? INBOX_ENTRY_STATUSES.ACKED : INBOX_ENTRY_STATUSES.DELIVERED,
        deliveredAt: new Date(),
        ackedAt: i < opts.history ? new Date() : null,
      })),
    );
    await app.db.execute(sql`ANALYZE inbox_entries`);

    const live = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.status, INBOX_ENTRY_STATUSES.DELIVERED)));
    return { inboxId, chatId, liveIds: live.map((r) => r.id).sort((a, b) => a - b) };
  }

  describe("scanned status set", () => {
    it("is derived from the status domain rather than hardcoded", () => {
      // The direction of this assertion is the point. If a fourth status is
      // added, it must land in the scanned set so an ACK can still reject it
      // as a prefix gap. A hardcoded ["pending", "delivered"] would silently
      // skip it and let the commit through.
      expect([...inboxService.ACK_PREFIX_SCAN_STATUSES].sort()).toEqual(
        inboxEntryStatusSchema.options.filter((s) => s !== INBOX_ENTRY_STATUSES.ACKED).sort(),
      );
      expect(inboxService.ACK_PREFIX_SCAN_STATUSES).not.toContain(INBOX_ENTRY_STATUSES.ACKED);
    });

    it("covers every status the database itself allows", async () => {
      // Cross-check against the live CHECK constraint: it was added NOT VALID
      // and the domain has changed once before (a legacy `failed` value). If
      // the database domain and the shared enum ever diverge, the derived set
      // stops being equivalent to "everything except acked" and this fails.
      const [row] = await getApp().db.execute<{ def: string }>(sql`
        SELECT pg_get_constraintdef(oid) AS def
          FROM pg_constraint WHERE conname = 'ck_inbox_entries_status'`);
      const dbDomain = [...String(row?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(dbDomain).toEqual([...inboxEntryStatusSchema.options].sort());
    });
  });

  it("keeps ACK cost independent of chat history", async () => {
    const app = getApp();

    /** Run one real ACK, capturing every statement the service emits, then
     *  replay each against EXPLAIN ANALYZE and report the widest scan.
     *
     *  Capturing the service's own SQL — rather than a copy of the query
     *  written into this test — is what makes the guard survive refactors:
     *  inlining the query back into the service, or dropping the status
     *  restriction, both show up here.
     *
     *  The replay runs after the ACK has committed, so a correct
     *  implementation matches close to zero rows rather than the handful it
     *  saw live. What is being asserted is the presence of the restriction,
     *  not the live row count: a query missing it still reads the whole
     *  partition on replay, which is what makes the two cases separable. */
    async function widestScan(cursor: number, inboxId: string): Promise<number> {
      const captured: Array<{ query: string; params: unknown[] }> = [];
      const client = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
      const instrumented = Object.assign(
        drizzle(client, {
          schema,
          logger: { logQuery: (query, params) => captured.push({ query, params }) },
        }),
        { end: () => client.end() },
      ) as unknown as Database;

      try {
        await inboxService.ackThroughEntryIdForBoundAgents(instrumented, cursor, [inboxId]);
        const reads = captured.filter((c) => /^\s*select/i.test(c.query) && c.query.includes("inbox_entries"));
        expect(reads.length).toBeGreaterThan(0);

        let widest = 0;
        for (const c of reads) {
          const plan = await client.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${c.query}`, c.params as never[]);
          widest = Math.max(widest, deepestActualRows(plan[0]?.["QUERY PLAN"]?.[0]?.Plan));
        }
        return widest;
      } finally {
        await client.end();
      }
    }

    const small = await seedHistory(app, { history: 300, live: 4 });
    const smallScan = await widestScan(small.liveIds[0] ?? 0, small.inboxId);

    const large = await seedHistory(app, { history: 1500, live: 4 });
    const largeScan = await widestScan(large.liveIds[0] ?? 0, large.inboxId);

    // Five times the history must not cost more rows read. A few rows of slack
    // absorbs the live window; it is nowhere near the 1200-row difference a
    // history-proportional scan would produce.
    expect(largeScan).toBeLessThanOrEqual(smallScan + 8);
    expect(largeScan).toBeLessThan(100);
  });

  it("commits through a long acked history in the chat_id IS NULL partition", async () => {
    const app = getApp();
    const { inboxId, liveIds } = await seedHistory(app, { history: 400, live: 3, nullChat: true });
    const target = liveIds[liveIds.length - 1];
    expect(target).toBeDefined();

    const result = await inboxService.ackThroughEntryIdForBoundAgents(app.db, target ?? 0, [inboxId]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe("acked");
    expect(result.ackedCount).toBe(3);

    const remaining = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.status, INBOX_ENTRY_STATUSES.DELIVERED)));
    expect(remaining).toHaveLength(0);
  });

  it("still rejects a gap that sits behind a long acked history", async () => {
    const app = getApp();
    const { inboxId, liveIds } = await seedHistory(app, { history: 400, live: 3 });
    const [first, , third] = liveIds;
    expect(first).toBeDefined();

    // Turn the first live row into a never-delivered pending row: it is now a
    // genuine prefix gap sitting far above the acked history.
    await app.db
      .update(inboxEntries)
      .set({ status: INBOX_ENTRY_STATUSES.PENDING, deliveredAt: null })
      .where(eq(inboxEntries.id, first ?? 0));

    const rejected = await inboxService.ackThroughEntryIdForBoundAgents(app.db, third ?? 0, [inboxId]);
    expect(rejected).toEqual({ ok: false, reason: "prefix_gap" });
  });
});

type PlanNode = { "Actual Rows"?: number; Plans?: PlanNode[] };

/** Rows touched by the deepest scan node — what "how much did this read" means
 *  once the planner has layered sorts and lock nodes on top. */
function deepestActualRows(node: PlanNode | undefined): number {
  if (!node) return 0;
  const children = node.Plans ?? [];
  if (children.length === 0) return node["Actual Rows"] ?? 0;
  return Math.max(...children.map(deepestActualRows));
}
