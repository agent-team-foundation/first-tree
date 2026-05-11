import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { connectDatabase } from "../db/connection.js";

/** Fixed UUID for the default organization used across all tests. */
// Fixed test fixture UUID — not a real org, recreated before each test
export const DEFAULT_ORG_ID = "01961234-0000-7000-8000-000000000000";

// Switch this worker process to its dedicated pre-created DB. Done eagerly
// at module load (i.e. once per worker process — even with `isolate: false`,
// vitest re-evaluates setupFiles per worker) so any code that reads
// process.env.DATABASE_URL afterwards sees the worker-scoped URL.
selectWorkerDatabase();

function selectWorkerDatabase() {
  const baseUrl = process.env.VITEST_PG_BASE_URL;
  const maxWorkers = Number.parseInt(process.env.VITEST_PG_MAX_WORKERS ?? "1", 10);
  if (!baseUrl) return;
  // VITEST_POOL_ID is 1-based per pool slot. Modulo-cap so values larger than
  // the pre-created DB count fall back to a valid one (defensive — the cap
  // matches vitest.config's maxForks today).
  const rawId = Number.parseInt(process.env.VITEST_POOL_ID ?? "1", 10);
  const slot = ((rawId - 1) % Math.max(1, maxWorkers)) + 1;
  const workerUrl = new URL(baseUrl);
  workerUrl.pathname = `/vitest_w${slot}`;
  process.env.DATABASE_URL = workerUrl.toString();
}

// Reuse a single DB connection across all beforeEach calls
let cachedDb: ReturnType<typeof connectDatabase> | undefined;
function getDb() {
  if (!cachedDb) {
    cachedDb = connectDatabase(process.env.DATABASE_URL ?? "");
  }
  return cachedDb;
}

// Tables truncated before every test. Listed explicitly (rather than relying
// on CASCADE NOTICE chains) so adding a new table forces a deliberate
// decision about whether tests should see clean state.
const TRUNCATE_TABLES = [
  "adapter_message_references",
  "adapter_chat_mappings",
  "adapter_agent_mappings",
  "adapter_configs",
  "inbox_entries",
  "session_events",
  "notifications",
  "messages",
  "chat_subscriptions",
  "chat_participants",
  "chats",
  "agent_chat_sessions",
  "agent_configs",
  "agent_presence",
  "invitation_redemptions",
  "invitations",
  "auth_identities",
  "members",
  "agents",
  "users",
  "clients",
  "processed_events",
  "server_instances",
  "organizations",
].join(", ");

beforeEach(async () => {
  const db = getDb();
  // Silence cascade NOTICE chatter that otherwise floods test stdout.
  await db.execute(sql`SET client_min_messages TO WARNING`);
  await db.execute(sql.raw(`TRUNCATE TABLE ${TRUNCATE_TABLES} CASCADE`));
  // Re-insert default organization with UUID PK (required by agents/chats FK constraints)
  await db.execute(
    sql`INSERT INTO organizations (id, name, display_name) VALUES (${DEFAULT_ORG_ID}, 'default', 'Default Organization') ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await cachedDb?.end();
  cachedDb = undefined;
});
