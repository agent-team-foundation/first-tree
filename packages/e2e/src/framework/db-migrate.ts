/**
 * Drizzle migration step in the readiness matrix.
 *
 * In M1, the server's own boot path runs `runMigrations(serverConfig.database.url)`
 * at `packages/server/src/index.ts` (line ~53, the `runStage("runMigrations", …)`
 * call) before opening the HTTP listener. The 20s budget there is identical to
 * the Docker HEALTHCHECK start-period, so by the time the framework's
 * `waitForHttp("/healthz", … consecutive: 3)` returns, migrations have
 * provably succeeded on the e2e PG.
 *
 * This module is intentionally a placeholder rather than a parallel migration
 * runner because:
 *   - Driving `drizzle-kit migrate` from the framework would double-migrate
 *     and break the journal advisory-lock invariant (`bootstrap-migration-lock.test.ts`).
 *   - Per proposal §六.3, the requirement is "migration must complete before
 *     readiness is signalled". Letting the server own it satisfies that with
 *     fewer moving parts.
 *
 * M2/M3 entry points if we ever need to drive migrations independently
 * (baseline-dump regression per §十一.1):
 *
 *   - `applyMigrationsTo(databaseUrl)` — call `runMigrations` from
 *     `@first-tree/server` directly. Today blocked by the server build
 *     not exporting it through the package's public surface; would require
 *     a `db:migrate` script entry instead of a source import (so the e2e
 *     package keeps its "no source imports" rule from §三.3).
 *
 *   - `dumpSchemaToBaseline(databaseUrl, path)` — for upgrade-path regression.
 *
 * Until that work is needed, this module exists so the directory contract in
 * proposal §五 stays satisfied and future readers find this design note here
 * rather than reverse-engineering it from `server/src/index.ts`.
 */

export const MIGRATION_OWNER = "server-boot" as const;

export type MigrationOwner = typeof MIGRATION_OWNER;

/**
 * Explicitly declares which subsystem is responsible for applying drizzle
 * migrations in the active readiness matrix. Returns the static answer for
 * M1 ("server boot") so call sites that want to assert the contract can.
 */
export function getMigrationOwner(): MigrationOwner {
  return MIGRATION_OWNER;
}
