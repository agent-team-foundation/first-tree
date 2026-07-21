import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { expect, it } from "vitest";
import { sslOptions } from "../db/connection.js";

const MIGRATION_TAG = "0082_processed_event_claim_lifecycle";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function splitSql(source: string): string[] {
  return source
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function extractDocumentedSql(source: string, marker: string): string {
  const startMarker = `<!-- ${marker}:start -->`;
  const endMarker = `<!-- ${marker}:end -->`;
  const markerStart = source.indexOf(startMarker);
  const markerEnd = source.indexOf(endMarker, markerStart + startMarker.length);
  if (markerStart < 0 || markerEnd < 0) {
    throw new Error(`Missing documented SQL markers for ${marker}`);
  }

  const markedSection = source.slice(markerStart + startMarker.length, markerEnd);
  const fenceStart = markedSection.indexOf("```sql\n");
  const sqlStart = fenceStart + "```sql\n".length;
  const fenceEnd = markedSection.indexOf("```", sqlStart);
  if (fenceStart < 0 || fenceEnd < 0) {
    throw new Error(`Missing SQL fence for ${marker}`);
  }
  return markedSection.slice(sqlStart, fenceEnd).trim();
}

function extractLegacyTableDdl(source: string): string {
  const match = source.match(/CREATE TABLE IF NOT EXISTS "processed_events" \([\s\S]*?\n\);/);
  if (!match) throw new Error("Migration 0003 is missing the legacy processed_events table DDL");
  return match[0];
}

it("migrates and reverses the processed-event claim lifecycle in an isolated schema", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("PostgreSQL test URL is not configured");

  const migrationPath = resolve(import.meta.dirname, `../../drizzle/${MIGRATION_TAG}.sql`);
  const legacyMigrationPath = resolve(import.meta.dirname, "../../drizzle/0003_feishu_adapter.sql");
  const journalPath = resolve(import.meta.dirname, "../../drizzle/meta/_journal.json");
  const rollbackDocPath = resolve(import.meta.dirname, "../../../../docs/migration/processed-event-claim-lifecycle.md");
  const [migrationSql, legacyMigrationSql, journalSource, rollbackDoc] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(legacyMigrationPath, "utf8"),
    readFile(journalPath, "utf8"),
    readFile(rollbackDocPath, "utf8"),
  ]);
  const legacyTableDdl = extractLegacyTableDdl(legacyMigrationSql);
  const cleanupSql = extractDocumentedSql(rollbackDoc, "processed-events-rollback-cleanup");
  const reverseSql = extractDocumentedSql(rollbackDoc, "processed-events-full-reverse");
  const journal = JSON.parse(journalSource) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const migrationEntry = journal.entries.find((entry) => entry.tag === MIGRATION_TAG);
  if (!migrationEntry) throw new Error(`Journal is missing ${MIGRATION_TAG}`);

  const schemaName = `migration_317_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const isolated = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    ...sslOptions(databaseUrl),
  });
  let ledgerRow: { id: number; hash: string; created_at: number | string | null } | undefined;

  try {
    await isolated`CREATE SCHEMA ${isolated(schemaName)}`;
    await isolated`SELECT set_config('search_path', ${schemaName}, false)`;
    [ledgerRow] = await isolated<Array<{ id: number; hash: string; created_at: number | string | null }>>`
      SELECT "id", "hash", "created_at"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${migrationEntry.when}
    `;
    expect(ledgerRow).toBeDefined();
    const [latestLedger] = await isolated<Array<{ created_at: number | string | null }>>`
      SELECT max("created_at") AS "created_at"
      FROM "drizzle"."__drizzle_migrations"
    `;
    expect(Number(latestLedger?.created_at)).toBe(migrationEntry.when);

    await isolated.unsafe(legacyTableDdl);
    await isolated`
        INSERT INTO "processed_events" ("event_id", "platform")
        VALUES ('legacy-delivery', 'github')
      `;

    await isolated.begin(async (transaction) => {
      for (const statement of splitSql(migrationSql)) {
        await transaction.unsafe(statement);
      }
    });

    const [legacyRow] = await isolated<Array<{ eventId: string; status: string; expiresAt: Date | null }>>`
        SELECT "event_id" AS "eventId", "status", "expires_at" AS "expiresAt"
        FROM "processed_events"
        WHERE "event_id" = 'legacy-delivery'
      `;
    expect(legacyRow).toEqual({ eventId: "legacy-delivery", status: "done", expiresAt: null });

    await isolated`
        INSERT INTO "processed_events" ("event_id", "platform")
        VALUES ('old-shape-delivery', 'github')
      `;
    const [oldShapeRow] = await isolated<Array<{ status: string; expiresAt: Date | null }>>`
        SELECT "status", "expires_at" AS "expiresAt"
        FROM "processed_events"
        WHERE "event_id" = 'old-shape-delivery'
      `;
    expect(oldShapeRow).toEqual({ status: "done", expiresAt: null });
    await isolated`
        INSERT INTO "processed_events" ("event_id", "platform", "status", "expires_at")
        VALUES ('pending-delivery', 'github', 'pending', now() + interval '5 minutes')
      `;

    await expect(
      isolated`
          INSERT INTO "processed_events" ("event_id", "platform", "status")
          VALUES ('invalid-status', 'github', 'invalid')
        `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      isolated`
          INSERT INTO "processed_events" ("event_id", "platform", "status")
          VALUES ('pending-without-expiry', 'github', 'pending')
        `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      isolated`
          INSERT INTO "processed_events" ("event_id", "platform", "status", "expires_at")
          VALUES ('done-with-expiry', 'github', 'done', now() + interval '5 minutes')
        `,
    ).rejects.toMatchObject({ code: "23514" });

    const columns = await isolated<Array<{ columnName: string; nullable: string; defaultValue: string | null }>>`
        SELECT
          "column_name" AS "columnName",
          "is_nullable" AS "nullable",
          "column_default" AS "defaultValue"
        FROM "information_schema"."columns"
        WHERE "table_schema" = ${schemaName}
          AND "table_name" = 'processed_events'
          AND "column_name" IN ('status', 'expires_at')
        ORDER BY "ordinal_position"
      `;
    expect(columns).toEqual([
      { columnName: "status", nullable: "NO", defaultValue: "'done'::text" },
      { columnName: "expires_at", nullable: "YES", defaultValue: null },
    ]);

    const [constraint] = await isolated<Array<{ validated: boolean }>>`
        SELECT constraint_row."convalidated" AS "validated"
        FROM "pg_constraint" AS constraint_row
        JOIN "pg_class" AS table_row ON table_row."oid" = constraint_row."conrelid"
        JOIN "pg_namespace" AS namespace_row ON namespace_row."oid" = table_row."relnamespace"
        WHERE constraint_row."conname" = 'ck_processed_events_lifecycle'
          AND namespace_row."nspname" = ${schemaName}
          AND table_row."relname" = 'processed_events'
      `;
    expect(constraint).toEqual({ validated: true });

    const [pendingIndex] = await isolated<Array<{ definition: string; valid: boolean; partial: boolean }>>`
        SELECT
          pg_get_indexdef("indexrelid") AS "definition",
          "indisvalid" AS "valid",
          "indpred" IS NOT NULL AS "partial"
        FROM "pg_index"
        JOIN "pg_class" ON "pg_class"."oid" = "pg_index"."indexrelid"
        JOIN "pg_namespace" ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = ${schemaName}
          AND "pg_class"."relname" = 'idx_processed_events_pending_expiry'
      `;
    expect(pendingIndex?.valid).toBe(true);
    expect(pendingIndex?.partial).toBe(true);
    const normalizedIndexDefinition = pendingIndex?.definition.replaceAll('"', "").replace(/\s+/g, " ");
    expect(normalizedIndexDefinition).toContain("USING btree (expires_at, id)");
    expect(normalizedIndexDefinition).toContain("WHERE (status = 'pending'::text)");

    const cleanupStatements = splitSql(cleanupSql);
    expect(cleanupStatements).toHaveLength(1);
    const cleanupStatement = cleanupStatements[0];
    if (!cleanupStatement) throw new Error("Documented pending-claim cleanup SQL is empty");
    const cleanedRows = await isolated.unsafe<Array<{ event_id: string }>>(cleanupStatement);
    expect(cleanedRows.map((row) => row.event_id).sort()).toEqual(["pending-delivery"]);
    const [pendingCount] = await isolated<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
        FROM "processed_events"
        WHERE "status" = 'pending'
      `;
    expect(pendingCount?.count).toBe(0);

    for (const statement of splitSql(reverseSql)) {
      await isolated.unsafe(statement);
    }

    const remainingColumns = await isolated<Array<{ columnName: string }>>`
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = ${schemaName}
          AND "table_name" = 'processed_events'
        ORDER BY "ordinal_position"
      `;
    expect(remainingColumns.map((column) => column.columnName)).toEqual(["id", "event_id", "platform", "created_at"]);

    await isolated`
        INSERT INTO "processed_events" ("event_id", "platform")
        VALUES ('post-reversal-delivery', 'github')
      `;
    await expect(
      isolated`
          INSERT INTO "processed_events" ("event_id", "platform")
          VALUES ('legacy-delivery', 'github')
        `,
    ).rejects.toMatchObject({ code: "23505" });

    const [ledgerCount] = await isolated<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
        FROM "drizzle"."__drizzle_migrations"
        WHERE "created_at" = ${migrationEntry.when}
      `;
    expect(ledgerCount?.count).toBe(0);

    await isolated.begin(async (transaction) => {
      for (const statement of splitSql(migrationSql)) {
        await transaction.unsafe(statement);
      }
    });
    const [reappliedRow] = await isolated<Array<{ status: string; expiresAt: Date | null }>>`
        SELECT "status", "expires_at" AS "expiresAt"
        FROM "processed_events"
        WHERE "event_id" = 'post-reversal-delivery'
      `;
    expect(reappliedRow).toEqual({ status: "done", expiresAt: null });
  } finally {
    try {
      await isolated.unsafe("ROLLBACK").catch(() => undefined);
      if (ledgerRow) {
        await isolated`
          INSERT INTO "drizzle"."__drizzle_migrations" ("id", "hash", "created_at")
          VALUES (${ledgerRow.id}, ${ledgerRow.hash}, ${ledgerRow.created_at})
          ON CONFLICT ("id") DO UPDATE SET
            "hash" = EXCLUDED."hash",
            "created_at" = EXCLUDED."created_at"
        `;
      }
      await isolated`DROP SCHEMA IF EXISTS ${isolated(schemaName)} CASCADE`;
    } finally {
      await isolated.end();
    }
  }
});
