import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import * as inboxService from "../services/inbox.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Regression guards for PERF-008: ACK-through must cost the in-flight delta,
 * not the chat's history.
 *
 * Before the fix, `ackThroughEntryIdForBoundAgents` selected — and, under
 * `FOR UPDATE`, locked — every notify row in the partition up to the cursor,
 * including long-acked rows that can never change the outcome. These tests pin
 * both halves of that defect: the scan volume and the lock footprint.
 */
describe("inbox ACK scales with the delta, not chat history", () => {
  const getApp = useTestApp();

  const HISTORY_ROWS = 3000;

  /**
   * Seed `HISTORY_ROWS` already-acked notify rows into one (inbox, chat)
   * partition. Written as bulk SQL rather than through the message API on
   * purpose: the point is a long history, and 3000 HTTP round trips would
   * dominate the test's runtime without changing what is being measured.
   */
  async function seedAckedHistory(app: FastifyInstance) {
    const uid = crypto.randomUUID().slice(0, 8);
    const receiverName = `ackscale-r-${uid}`;
    const sender = await createTestAgent(app, { name: `ackscale-s-${uid}` });
    const receiver = await createTestAgent(app, { name: receiverName });
    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [receiver.agent.uuid],
    });
    const chatId: string = chatRes.json().id;
    const inboxId = receiver.agent.inboxId;

    await app.db.execute(sql`
      INSERT INTO messages (id, chat_id, sender_id, format, content, metadata, source, created_at)
      SELECT ${`hist-${uid}-`} || g, ${chatId}, ${sender.agent.uuid}, 'text',
             to_jsonb('history ' || g), '{}'::jsonb, 'api',
             now() - make_interval(secs => ${HISTORY_ROWS} - g)
      FROM generate_series(1, ${HISTORY_ROWS}) g
    `);
    await app.db.execute(sql`
      INSERT INTO inbox_entries (inbox_id, message_id, chat_id, status, notify, created_at, delivered_at, acked_at)
      SELECT ${inboxId}, ${`hist-${uid}-`} || g, ${chatId}, 'acked', true,
             now() - make_interval(secs => ${HISTORY_ROWS} - g),
             now() - make_interval(secs => ${HISTORY_ROWS} - g),
             now() - make_interval(secs => ${HISTORY_ROWS} - g)
      FROM generate_series(1, ${HISTORY_ROWS}) g
    `);
    // The planner needs statistics to prefer the partial index over a seq scan.
    await app.db.execute(sql`ANALYZE inbox_entries`);

    return { sender, receiverName, chatId, inboxId };
  }

  /** Deliver one fresh notify row on top of the seeded history. */
  async function deliverOneOnTop(
    app: FastifyInstance,
    sender: Awaited<ReturnType<typeof createTestAgent>>,
    chatId: string,
    receiverName: string,
    inboxId: string,
  ) {
    await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "live trigger",
      receiverNames: [receiverName],
    });
    const delivered = await inboxService.claimBacklogForPush(app.db, inboxId, 10);
    const entry = delivered.at(-1);
    if (!entry) throw new Error("expected a delivered entry on top of the seeded history");
    return entry;
  }

  /** Sum every row a plan node actually touched, across the whole plan tree. */
  function countTouchedRows(node: Record<string, unknown>): number {
    const actual = typeof node["Actual Rows"] === "number" ? node["Actual Rows"] : 0;
    const filtered = typeof node["Rows Removed by Filter"] === "number" ? node["Rows Removed by Filter"] : 0;
    const children = Array.isArray(node.Plans) ? (node.Plans as Array<Record<string, unknown>>) : [];
    return actual + filtered + children.reduce((sum, child) => sum + countTouchedRows(child), 0);
  }

  it("keeps the non-acked clause a literal so the partial index survives a generic plan", () => {
    // First of the two guards, and the one that catches an edit to the
    // service. `ne(inboxEntries.status, "acked")` reads better and produces a
    // bound parameter, which PostgreSQL cannot use to prove the partial-index
    // predicate once the statement switches to a generic plan — the scan then
    // silently reverts to whole-partition. A plan-level assertion cannot see
    // that change (it would be exercising the test's own SQL), so pin the
    // property directly on the clause the service uses.
    const compiled = getApp()
      .db.select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(inboxService.NOT_ACKED_PREFIX_ROW)
      .toSQL();

    expect(compiled.params).toEqual([]);
    expect(compiled.sql).toContain("<> 'acked'");
  });

  it("reads only the non-acked delta under a generic plan, not the whole notify history", async () => {
    const app = getApp();
    const { sender, receiverName, chatId, inboxId } = await seedAckedHistory(app);
    const entry = await deliverOneOnTop(app, sender, chatId, receiverName, inboxId);

    // Second guard: the planner contract the literal above depends on. It has
    // to run under a forced generic plan, because that is the only mode where
    // a partial index can stop matching — under a custom plan every spelling
    // looks fine and the guard would be decorative.
    //
    // `notify` and the cursor stay bound parameters here on purpose: that is
    // how the service passes them, and keeping `notify` out of the index
    // predicate is what lets a parameter still act as an index condition.
    //
    // Known boundary: this exercises an equivalent statement, not the query
    // object the service builds. Together with the literal guard above it
    // covers the clause and the index contract, but a future restructuring of
    // the service's own WHERE (an added OR branch, say) could stop matching the
    // index without either guard noticing. Closing that would mean exporting
    // the query builder purely for the test; the coupling was judged not worth
    // it, so the gap is recorded here instead of left implicit.
    const statement = `ack_prefix_guard_${crypto.randomUUID().replace(/-/g, "")}`;
    const plan = await app.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL plan_cache_mode = force_generic_plan`));
      await tx.execute(
        sql.raw(`
          PREPARE ${statement} (text, text, boolean, bigint) AS
          SELECT id, status, delivered_at FROM inbox_entries
           WHERE inbox_id = $1 AND chat_id = $2 AND notify = $3
             AND status <> 'acked' AND id <= $4
           ORDER BY id
        `),
      );
      // EXECUTE arguments cannot themselves be bind parameters, so the values
      // are inlined. That does not weaken the test: `force_generic_plan` above
      // already forced the plan to be built without knowing them.
      const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const explained = await tx.execute<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
        sql.raw(
          `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE ${statement}(${literal(inboxId)}, ${literal(chatId)}, true, ${entry.id})`,
        ),
      );
      // No DEALLOCATE on the error path: PostgreSQL discards a statement
      // prepared inside a transaction when that transaction rolls back.
      await tx.execute(sql.raw(`DEALLOCATE ${statement}`));
      return explained[0]?.["QUERY PLAN"]?.[0]?.Plan;
    });
    if (!plan) throw new Error("EXPLAIN returned no plan");

    // One delivered row is the entire committable delta. Slack is generous
    // because the exact plan node is the planner's choice; what must hold is
    // that the work does not scale with HISTORY_ROWS. Pre-fix, this query
    // touched HISTORY_ROWS + 1 rows.
    expect(countTouchedRows(plan)).toBeLessThan(50);
    expect(JSON.stringify(plan)).toContain("idx_inbox_unacked_cursor");
  });

  it("does not lock already-acked history, so an ACK cannot queue behind it", async () => {
    const app = getApp();
    const { sender, receiverName, chatId, inboxId } = await seedAckedHistory(app);
    const entry = await deliverOneOnTop(app, sender, chatId, receiverName, inboxId);

    const [oldestAcked] = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.status, "acked")))
      .orderBy(asc(inboxEntries.id))
      .limit(1);
    if (!oldestAcked) throw new Error("expected seeded acked history");

    // Hold a row lock on one long-acked row, then ACK through a cursor above
    // it. The pre-fix prefix scan locked every notify row up to the cursor, so
    // it would block here until this transaction released. The delta scan
    // never touches acked rows, so the ACK must complete while the lock is
    // still held.
    let releaseHolder: (() => void) | undefined;
    const holderReady = new Promise<void>((resolveReady) => {
      const holding = new Promise<void>((resolveRelease) => {
        releaseHolder = resolveRelease;
      });
      void app.db.transaction(async (tx) => {
        await tx
          .select({ id: inboxEntries.id })
          .from(inboxEntries)
          .where(eq(inboxEntries.id, oldestAcked.id))
          .for("update");
        resolveReady();
        await holding;
      });
    });
    await holderReady;

    try {
      const ackOrTimeout = await Promise.race([
        inboxService
          .ackEntryByIdForBoundAgents(app.db, entry.id, [inboxId])
          .then((res) => ({ kind: "ack", res }) as const),
        new Promise<{ kind: "timeout" }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ kind: "timeout" }), 5_000),
        ),
      ]);

      expect(ackOrTimeout.kind).toBe("ack");
      if (ackOrTimeout.kind !== "ack") throw new Error("ACK blocked on already-acked history");
      expect(ackOrTimeout.res.ok).toBe(true);
      if (!ackOrTimeout.res.ok) throw new Error("ack-through unexpectedly rejected");
      expect(ackOrTimeout.res.ackedEntryIds).toEqual([entry.id]);
    } finally {
      releaseHolder?.();
    }
  });

  it("commits correctly with a long acked prefix in front of the cursor", async () => {
    const app = getApp();
    const { sender, receiverName, chatId, inboxId } = await seedAckedHistory(app);
    const entry = await deliverOneOnTop(app, sender, chatId, receiverName, inboxId);

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    expect(accepted.disposition).toBe("acked");
    expect(accepted.ackedCount).toBe(1);
    expect(accepted.ackedEntryIds).toEqual([entry.id]);
    expect(accepted.throughEntry.status).toBe("acked");

    // The seeded history is untouched: ACK commits the delta, not the prefix.
    const stillAcked = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.status, "acked")));
    expect(stillAcked[0]?.count).toBe(HISTORY_ROWS + 1);

    // A duplicate ACK over the same long prefix stays a no-op.
    const duplicate = await inboxService.ackEntryByIdForBoundAgents(app.db, entry.id, [inboxId]);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate ack unexpectedly rejected");
    expect(duplicate.disposition).toBe("already_acked");
    expect(duplicate.ackedCount).toBe(0);
  });
});
