import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { sslOptions } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

/**
 * Pins the `hashtext('drizzle_migrations')` key used by
 * `preflightMigrationLock`. If a future drizzle bump changes the lock key,
 * this test stays green only as long as the preflight constant matches the
 * one we hold here — meaning the preflight and the holder both speak to the
 * same advisory-lock slot.
 *
 * See `packages/server/src/db/migrate.ts` `MIGRATION_LOCK_KEY_SQL` comment
 * for the verification path through drizzle-orm.
 */
describe("preflightMigrationLock (T10)", () => {
  const databaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    // No shared state between cases — each opens / closes its own postgres
    // client, and the lock is session-scoped so it goes away on .end().
  });

  it("throws migration lock contention when another session holds hashtext('drizzle_migrations')", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";

    // Hold the advisory lock from a separate session for the duration of
    // the test. `pg_advisory_lock` blocks if contested, but we're the only
    // contender so it returns immediately.
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    try {
      await holder`SELECT pg_advisory_lock(hashtext('drizzle_migrations'))`;

      // Use a tight 2s preflight timeout so the contention path completes
      // fast. The 30s production default is the right answer for boot, not
      // for a unit test that just needs to assert the error path.
      await expect(runMigrations(url, { lockTimeoutMs: 2_000 })).rejects.toThrow(/migration lock contention/);
    } finally {
      // Release the lock so subsequent test runs (and other test files in
      // the same worker process) aren't blocked.
      await holder`SELECT pg_advisory_unlock(hashtext('drizzle_migrations'))`;
      await holder.end();
    }
  });

  it("succeeds when the advisory lock is free", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    // Sanity case: with no holder, preflight returns fast and migrate runs.
    const tableCount = await runMigrations(databaseUrl ?? "");
    expect(tableCount).toBeGreaterThan(0);
  });
});
