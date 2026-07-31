import { sql, TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";

let db: ReturnType<typeof connectDatabase> | undefined;

function getDb(): ReturnType<typeof connectDatabase> {
  if (!db) db = connectDatabase(process.env.DATABASE_URL ?? "");
  return db;
}

describe("inbox delivery indexes", () => {
  afterAll(async () => {
    await db?.end();
    db = undefined;
  });

  it("creates the message_id/status index used by deliveryStatus lookups", async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'inbox_entries'
        AND indexname = 'idx_inbox_entries_message_status'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("USING btree (message_id, status)");
  });

  it("constrains inbox entry status to active delivery states", async () => {
    const rows = await getDb().execute<{ definition: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'inbox_entries'::regclass
        AND conname = 'ck_inbox_entries_status'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain("status = ANY");
    expect(rows[0]?.definition).toContain("pending");
    expect(rows[0]?.definition).toContain("delivered");
    expect(rows[0]?.definition).toContain("acked");
    expect(rows[0]?.definition).not.toContain("failed");
    expect(rows[0]?.definition).toContain("NOT VALID");
  });

  it("creates the partial unacked-cursor index used by ACK-through delta scans", async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'inbox_entries'
        AND indexname = 'idx_inbox_unacked_cursor'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("USING btree (inbox_id, chat_id, notify, id)");
    expect(rows[0]?.indexdef).toContain("WHERE (status = ANY (ARRAY['pending'::text, 'delivered'::text]))");
  });

  it("serves every ACK-through predicate from the partial unacked-cursor index", async () => {
    // PERF-008 regression pin: each statement the ACK commit issues must stay
    // inside the `status IN ('pending','delivered')` partial index, or per-ACK
    // cost silently degrades back to O(chat history). Partial-index matching
    // is a logical-implication check on the statement's WHERE clause, so this
    // test fails as soon as an ACK predicate drifts outside the index shape.
    //
    // Everything below runs in one rolled-back transaction:
    //   - seed an acked-heavy distribution (the PERF-008 scenario) so the
    //     planner has real statistics; `session_replication_role = replica`
    //     skips FK enforcement because message rows are irrelevant here, and
    //     the rollback keeps the fabricated rows out of the shared worker DB;
    //   - drop the sibling inbox indexes and price out seq scans so the plan
    //     choice is deterministic: either the partial index provably covers
    //     the predicate, or the plan degrades to the asserted-against
    //     full-prefix fallback (pkey range / seq scan).
    const ackStatements = {
      "gap probe": sql`
        SELECT id FROM inbox_entries
        WHERE inbox_id = 'inbox_x' AND chat_id = 'chat_x' AND notify = true
          AND id <= 999999999 AND status = 'pending' AND delivered_at IS NULL
        ORDER BY id LIMIT 1
      `,
      "delivered promotion": sql`
        UPDATE inbox_entries SET status = 'acked'
        WHERE inbox_id = 'inbox_x' AND chat_id = 'chat_x' AND notify = true
          AND id <= 999999999 AND status = 'delivered'
      `,
      "reset-delivered promotion": sql`
        UPDATE inbox_entries SET status = 'acked'
        WHERE inbox_id = 'inbox_x' AND chat_id = 'chat_x' AND notify = true
          AND id <= 999999999 AND status = 'pending' AND delivered_at IS NOT NULL
      `,
      "silent drain": sql`
        UPDATE inbox_entries SET status = 'acked'
        WHERE inbox_id = 'inbox_x' AND chat_id = 'chat_x' AND notify = false
          AND id <= 999999999 AND status = 'pending'
      `,
    };

    try {
      await getDb().transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
        await tx.execute(sql`
          INSERT INTO inbox_entries (inbox_id, message_id, chat_id, status, notify, delivered_at, acked_at)
          SELECT 'inbox_x', 'perf008-acked-' || g, 'chat_x', 'acked', true, now(), now()
          FROM generate_series(1, 500) AS g
        `);
        await tx.execute(sql`
          INSERT INTO inbox_entries (inbox_id, message_id, chat_id, status, notify, delivered_at)
          VALUES
            ('inbox_x', 'perf008-delivered-1', 'chat_x', 'delivered', true, now()),
            ('inbox_x', 'perf008-delivered-2', 'chat_x', 'delivered', true, now()),
            ('inbox_x', 'perf008-reset-1', 'chat_x', 'pending', true, now()),
            ('inbox_x', 'perf008-silent-1', 'chat_x', 'pending', false, NULL)
        `);
        await tx.execute(sql`ANALYZE inbox_entries`);
        await tx.execute(
          sql`DROP INDEX idx_inbox_pending, idx_inbox_pending_notify, idx_inbox_chat_silent, idx_inbox_entries_message_status`,
        );
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);

        for (const [label, statement] of Object.entries(ackStatements)) {
          const plan = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN (FORMAT TEXT) ${statement}`);
          const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
          expect(planText, `${label} must use idx_inbox_unacked_cursor`).toContain("idx_inbox_unacked_cursor");
        }

        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
  });

  it("creates the chat_id/agent_id index used by chat agent status lookups", async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_chat_sessions'
        AND indexname = 'idx_agent_chat_sessions_chat_agent'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("USING btree (chat_id, agent_id)");
  });
});
