import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Resolve the drizzle migrations directory.
 * 1. npm install: embedded at dist/drizzle/ (relative to the built CLI)
 * 2. Monorepo dev: resolved from @agent-hub/server package
 */
function resolveMigrationsFolder(): string {
  // npm publish: migrations are embedded next to the built CLI
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const embeddedPath = join(cliDir, "..", "drizzle");
  if (existsSync(embeddedPath)) return embeddedPath;

  // Monorepo dev: resolve from server package
  const serverDir = dirname(fileURLToPath(import.meta.resolve("@agent-hub/server/package.json")));
  return join(serverDir, "drizzle");
}

/**
 * Run Drizzle database migrations.
 */
export async function runMigrations(databaseUrl: string): Promise<number> {
  const migrationsFolder = resolveMigrationsFolder();

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }

  // Count tables as a rough indicator of migration state
  const countClient = postgres(databaseUrl, { max: 1 });
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
