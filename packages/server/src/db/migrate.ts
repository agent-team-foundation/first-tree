import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sslOptions } from "./connection.js";

/**
 * Resolve the drizzle migrations directory.
 *
 * Two layouts to support:
 *   - Built (Docker): `packages/server/dist/index.mjs` + `packages/server/drizzle/`
 *     → `../drizzle` from the bundled file.
 *   - Dev (tsx):      `packages/server/src/db/migrate.ts` + `packages/server/drizzle/`
 *     → `../../drizzle` from the source file.
 */
function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "drizzle"), join(here, "..", "..", "drizzle")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate drizzle migrations folder relative to ${here}`);
}

/**
 * Validate that migration journal timestamps are strictly increasing.
 * Drizzle silently skips migrations whose `when` is <= the last applied
 * timestamp, which causes missing columns/tables with no error.
 */
function validateJournalOrder(migrationsFolder: string): void {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) return;

  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };

  let prevWhen = 0;
  let prevTag = "";
  for (const entry of journal.entries) {
    if (entry.when <= prevWhen) {
      throw new Error(
        `Migration journal timestamps are not monotonically increasing:\n` +
          `  "${prevTag}" (when: ${prevWhen}) >= "${entry.tag}" (when: ${entry.when})\n` +
          `  Drizzle will silently skip "${entry.tag}". Fix the 'when' values in:\n` +
          `  ${journalPath}`,
      );
    }
    prevWhen = entry.when;
    prevTag = entry.tag;
  }
}

/**
 * Advisory-lock key used by the preflight check.
 *
 * Verified against `drizzle-orm@0.44.7`:
 *   - `node_modules/drizzle-orm/postgres-js/migrator.js` → delegates to
 *     `node_modules/drizzle-orm/pg-core/dialect.js::migrate()`, which
 *     **does NOT acquire any advisory lock** in this version; it only wraps
 *     `INSERT INTO drizzle.__drizzle_migrations` in a transaction.
 *   - So this preflight is **purely defensive**: it surfaces *external*
 *     holders (an operator's `SELECT pg_advisory_lock(...)`, a stale
 *     prior-replica session that exited mid-migration with the lock held,
 *     or a future drizzle release that re-introduces locking) within the
 *     timeout window instead of letting drizzle hang silently.
 *
 * If you bump `drizzle-orm`, re-read `pg-core/dialect.js::migrate()` and
 * update this key (and `MIGRATION_LOCK_TIMEOUT_MS`) accordingly. The
 * integration test `bootstrap-migration-lock.test.ts` pins the contention
 * behavior using the same key.
 */
const MIGRATION_LOCK_KEY_SQL = "hashtext('drizzle_migrations')";
// Sits inside the 20s `runMigrations` stage budget set in `index.ts`; 15s
// preflight + ≥5s for the actual drizzle migrate call. If you raise either,
// raise the other in lockstep (and re-evaluate the Dockerfile HEALTHCHECK
// `--start-period`).
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 1_000;

export type RunMigrationsOptions = {
  /** Override the preflight advisory-lock timeout. Default 15s. */
  lockTimeoutMs?: number;
};

/**
 * Probe the advisory-lock key drizzle would use for migrations. If another
 * session holds it, fail with a clear message instead of letting drizzle's
 * `migrate()` hang forever. We don't keep the lock — see the key constant
 * above for the full rationale. See server-bootstrap-resilience-design.md §3 (T10).
 */
async function preflightMigrationLock(databaseUrl: string, timeoutMs: number): Promise<void> {
  const ssl = sslOptions(databaseUrl);
  const client = postgres(databaseUrl, { max: 1, ...ssl });
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const rows = (await client.unsafe(
        `SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY_SQL}) AS acquired`,
      )) as Array<{
        acquired: boolean;
      }>;
      if (rows[0]?.acquired) {
        await client.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY_SQL})`);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `migration lock contention — another process holds drizzle migration lock (${MIGRATION_LOCK_KEY_SQL}) ` +
            `after ${timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, MIGRATION_LOCK_POLL_INTERVAL_MS));
    }
  } finally {
    await client.end();
  }
}

/**
 * Run Drizzle database migrations. Returns the count of public tables after
 * migration, used as a rough indicator that the schema landed.
 */
export async function runMigrations(databaseUrl: string, options: RunMigrationsOptions = {}): Promise<number> {
  const migrationsFolder = resolveMigrationsFolder();

  validateJournalOrder(migrationsFolder);

  await preflightMigrationLock(databaseUrl, options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);

  const ssl = sslOptions(databaseUrl);

  const client = postgres(databaseUrl, { max: 1, ...ssl });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }

  const countClient = postgres(databaseUrl, { max: 1, ...ssl });
  try {
    const result = await countClient`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    return (result[0] as { count: number }).count;
  } finally {
    await countClient.end();
  }
}
