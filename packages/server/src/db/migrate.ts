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
 * Run Drizzle database migrations. Returns the count of public tables after
 * migration, used as a rough indicator that the schema landed.
 */
export async function runMigrations(databaseUrl: string): Promise<number> {
  const migrationsFolder = resolveMigrationsFolder();

  validateJournalOrder(migrationsFolder);

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
