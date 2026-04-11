import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { connectDatabase } from "../db/connection.js";

/** Fixed UUID for the default organization used across all tests. */
// Fixed test fixture UUID — not a real org, recreated before each test
export const DEFAULT_ORG_ID = "01961234-0000-7000-8000-000000000000";

// Reuse a single DB connection across all beforeEach calls
let cachedDb: ReturnType<typeof connectDatabase> | undefined;
function getDb() {
  if (!cachedDb) {
    cachedDb = connectDatabase(process.env.DATABASE_URL ?? "");
  }
  return cachedDb;
}

beforeEach(async () => {
  const db = getDb();
  await db.execute(sql`
    TRUNCATE TABLE
      task_chats,
      tasks,
      adapter_message_references,
      adapter_chat_mappings,
      adapter_agent_mappings,
      adapter_configs,
      inbox_entries,
      messages,
      chat_participants,
      chats,
      agent_tokens,
      agent_presence,
      agents,
      admin_users,
      clients,
      processed_events,
      system_configs,
      server_instances,
      organizations
    CASCADE
  `);
  // Re-insert default organization with UUID PK (required by agents/chats FK constraints)
  await db.execute(
    sql`INSERT INTO organizations (id, name, display_name) VALUES (${DEFAULT_ORG_ID}, 'default', 'Default Organization') ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await cachedDb?.end();
  cachedDb = undefined;
});
