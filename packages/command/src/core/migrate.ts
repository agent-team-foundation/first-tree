import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Mirror of packages/server/src/db/connection.ts — kept local to avoid pulling
// the server package into the command CLI bundle. RDS/Aurora enforces
// rds.force_ssl=1 with a cert outside Node's default CA bundle.
function sslOptions(url: string) {
  try {
    if (new URL(url).hostname.endsWith(".rds.amazonaws.com")) {
      return { ssl: { rejectUnauthorized: false } };
    }
  } catch {
    // Not a parseable URL — let postgres-js report the error.
  }
  return {};
}

/**
 * Resolve the drizzle migrations directory.
 * 1. npm install: embedded at dist/drizzle/ (relative to the built CLI)
 * 2. Monorepo dev: resolved from @first-tree-hub/server package
 */
function resolveMigrationsFolder(): string {
  // npm publish: migrations are embedded next to the built CLI
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const embeddedPath = join(cliDir, "..", "drizzle");
  if (existsSync(embeddedPath)) return embeddedPath;

  // Monorepo dev: resolve from server package
  const serverDir = dirname(fileURLToPath(import.meta.resolve("@first-tree-hub/server/package.json")));
  return join(serverDir, "drizzle");
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
 * Run Drizzle database migrations.
 */
export async function runMigrations(databaseUrl: string): Promise<number> {
  const migrationsFolder = resolveMigrationsFolder();

  // Fail fast if journal timestamps are out of order
  validateJournalOrder(migrationsFolder);

  const ssl = sslOptions(databaseUrl);

  const client = postgres(databaseUrl, { max: 1, ...ssl });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }

  // Count tables as a rough indicator of migration state
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
