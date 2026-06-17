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
