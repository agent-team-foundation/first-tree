import { sql } from "drizzle-orm";
import { beforeEach } from "vitest";
import { connectDatabase } from "../db/connection.js";

/** Fixed UUID for the default organization used across all tests. */
// Fixed test fixture UUID — not a real org, recreated before each test
export const DEFAULT_ORG_ID = "01961234-0000-7000-8000-000000000000";

beforeEach(async () => {
  const db = connectDatabase(process.env.DATABASE_URL ?? "");
  await db.execute(sql`
    SET client_min_messages TO WARNING;
    DO $$ DECLARE t text;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE 'TRUNCATE TABLE public.' || quote_ident(t) || ' CASCADE';
      END LOOP;
    END $$
  `);
  // Re-insert default organization with UUID PK (required by agents/chats FK constraints)
  await db.execute(
    sql`INSERT INTO organizations (id, name, display_name) VALUES (${DEFAULT_ORG_ID}, 'default', 'Default Organization') ON CONFLICT DO NOTHING`,
  );
});
