import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

type JournalEntry = { idx: number; tag: string; when: number };

/**
 * Resolve the migrations directory the way `runMigrations` does so the guard
 * agrees with what the migrator would actually apply.
 */
function resolveMigrationsFolder(): string {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const embeddedPath = join(cliDir, "..", "drizzle");
  if (existsSync(embeddedPath)) return embeddedPath;
  const serverDir = dirname(fileURLToPath(import.meta.resolve("@first-tree-hub/server/package.json")));
  return join(serverDir, "drizzle");
}

function readJournal(): JournalEntry[] {
  const journalPath = join(resolveMigrationsFolder(), "meta", "_journal.json");
  const raw = JSON.parse(readFileSync(journalPath, "utf-8")) as { entries?: JournalEntry[] };
  return raw.entries ?? [];
}

export type SchemaVersionMismatch = {
  kind: "db-older" | "db-newer";
  cliVersion: string;
  expectedCount: number;
  actualCount: number;
  expectedTag: string;
};

export class SchemaVersionMismatchError extends Error {
  readonly mismatch: SchemaVersionMismatch;
  constructor(mismatch: SchemaVersionMismatch) {
    super(formatSchemaMismatch(mismatch));
    this.name = "SchemaVersionMismatchError";
    this.mismatch = mismatch;
  }
}

function formatSchemaMismatch(m: SchemaVersionMismatch): string {
  if (m.kind === "db-older") {
    return (
      `Schema version mismatch. CLI v${m.cliVersion} expects ${m.expectedCount} ` +
      `migrations through "${m.expectedTag}", DB has ${m.actualCount}. ` +
      `Run 'first-tree-hub start --service' to apply pending migrations.`
    );
  }
  return (
    `Schema version mismatch. DB has ${m.actualCount} migrations applied, ` +
    `CLI v${m.cliVersion} only knows ${m.expectedCount} (last "${m.expectedTag}"). ` +
    `The CLI binary appears older than the database. Upgrade with ` +
    `'npm install -g @agent-team-foundation/first-tree-hub@latest'.`
  );
}

/**
 * Compare the migrations bundled into the running CLI binary against the
 * `__drizzle_migrations` table in the DB. This is the daemon's only
 * orchestration on every boot (Q11 / Pattern B): if the operator
 * `npm install`d a new tarball but didn't restart `start --service`, the
 * mismatch surfaces in `service logs` instead of the daemon silently
 * running stale code against a newer DB.
 *
 * The check is heuristic — drizzle's migration table stores SHA hashes, not
 * tags, and rebuilding hashes here would duplicate too much of the
 * migrator. Comparing counts is sufficient for the failure mode this guard
 * is meant to catch (forgot-to-restart upgrade flow).
 */
export async function assertSchemaCurrent(databaseUrl: string, cliVersion: string): Promise<void> {
  const journal = readJournal();
  const expectedCount = journal.length;
  const expectedTag = journal[journal.length - 1]?.tag ?? "<none>";

  const client = postgres(databaseUrl, { max: 1 });
  let actualCount: number;
  try {
    const rows = await client<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM "__drizzle_migrations"
    `;
    actualCount = rows[0]?.count ?? 0;
  } catch (err) {
    // 42P01 = `relation "__drizzle_migrations" does not exist`. Happens when
    // a daemon is invoked manually against a fresh DB (no parent CLI ran
    // migrations first). Treat as the strongest "db-older" signal —
    // actualCount=0 — so the message points the operator at
    // `start --service`.
    if (typeof err === "object" && err !== null && Reflect.get(err, "code") === "42P01") {
      actualCount = 0;
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }

  if (actualCount === expectedCount) return;
  throw new SchemaVersionMismatchError({
    kind: actualCount < expectedCount ? "db-older" : "db-newer",
    cliVersion,
    expectedCount,
    actualCount,
    expectedTag,
  });
}
