import { sql } from "drizzle-orm";
import { beforeEach } from "vitest";
import { connectDatabase } from "../db/connection.js";

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
});
