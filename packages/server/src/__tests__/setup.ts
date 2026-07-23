import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { connectDatabase } from "../db/connection.js";

/** Fixed UUID for the default organization used across all tests. */
// Fixed test fixture UUID — not a real org, recreated before each test
export const DEFAULT_ORG_ID = "01961234-0000-7000-8000-000000000000";

// Enable the dev-callback bypass for the whole test run. The codex P1-9
// hardening added an explicit opt-in env var on top of the existing
// `NODE_ENV !== "production"` gate; tests that exercise dev-callback
// (oauth-flow.test.ts and friends) would otherwise hit 404. Set once
// here so individual tests don't have to plumb it through.
//
// Per-worker-env note: `oauth-flow.test.ts` mutates and restores this
// var inside individual tests to exercise the disabled path. That's
// safe today because vitest's forks pool gives each worker process its
// own `process.env`; if the runner ever switches to a thread-pool model
// (or `pool: "vmThreads"` with shared env), those mutations would leak
// across tests. Re-evaluate then.
if (!process.env.FIRST_TREE_DEV_CALLBACK_ENABLED) {
  process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = "1";
}

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
  "github_entity_chat_mappings",
  "context_tree_io_events",
  "inbox_entries",
  "session_events",
  "notifications",
  "messages",
  "chat_user_state",
  "chat_membership",
  "chats",
  "agent_chat_sessions",
  "agent_resource_bindings",
  "resources",
  "agent_configs",
  "agent_presence",
  "invitation_redemptions",
  "invitations",
  "oauth_transactions",
  "auth_identity_refresh_operations",
  "auth_identity_retirement_fences",
  "auth_identities",
  "auth_identity_provider_heads",
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
