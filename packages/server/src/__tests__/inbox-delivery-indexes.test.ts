import { sql } from "drizzle-orm";
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

  it("keeps the preceding-context indexes partial and keyed on entry id", async () => {
    const rows = await getDb().execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'inbox_entries'
        AND indexname IN ('idx_inbox_chat_silent_pending', 'idx_inbox_chat_notify')
      ORDER BY indexname
    `);

    expect(rows).toHaveLength(2);
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    // `id` must stay in the key: the preceding-context window bounds are
    // correlated values inside a LATERAL, so without it the planner scans
    // every silent row in the chat.
    const silent = byName.get("idx_inbox_chat_silent_pending");
    expect(silent).toContain("(inbox_id, chat_id, id)");
    // Partial, not a wider composite — a key ending in the unique `id`
    // defeats B-tree deduplication and inflates the index several-fold.
    expect(silent).toContain("WHERE");
    expect(silent).toContain("notify = false");

    // The notify cursor must NOT be filtered on status: an already-acked
    // trigger still closes a preceding-context window, and ACK-through walks
    // acked rows to prove its prefix has no gap.
    const notify = byName.get("idx_inbox_chat_notify");
    expect(notify).toContain("(inbox_id, chat_id, id)");
    expect(notify).toContain("WHERE (notify");
    expect(notify).not.toContain("status");
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
