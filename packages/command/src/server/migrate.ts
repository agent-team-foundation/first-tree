import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Run Drizzle database migrations.
 * Migration files are located in the server package's drizzle/ directory.
 */
export async function runMigrations(databaseUrl: string): Promise<number> {
  // Resolve migration path relative to the server package
  const serverDir = dirname(fileURLToPath(import.meta.resolve("@agent-hub/server/package.json")));
  const migrationsFolder = join(serverDir, "drizzle");

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
