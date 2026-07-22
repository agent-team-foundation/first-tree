/**
 * Drain legacy inline-bytea attachment rows into S3.
 *
 * For every row with `data NOT NULL AND object_key IS NULL`: upload the
 * bytes to S3, then in one transaction set `object_key`, backfill `org_id`
 * (`uploaded_by → agents.organization_id`; NULL when unresolvable — the row
 * still downloads fine), and NULL out `data`. Idempotent and resumable:
 * completed rows are skipped by the batch query, failed rows keep their
 * bytea and the next run resumes on them. A `pg_advisory_lock` guards
 * against concurrent runs.
 *
 * Run:
 *   DATABASE_URL=... \
 *   FIRST_TREE_S3_ENDPOINT=http://localhost:9000 \
 *   FIRST_TREE_S3_REGION=us-east-1 \
 *   FIRST_TREE_S3_BUCKET=first-tree-attachments \
 *   FIRST_TREE_S3_ACCESS_KEY_ID=... FIRST_TREE_S3_SECRET_ACCESS_KEY=... \
 *   FIRST_TREE_S3_FORCE_PATH_STYLE=true \
 *   pnpm --filter @first-tree/server tsx scripts/migrate-attachments-to-s3.ts
 */

import { sql } from "drizzle-orm";
import { connectDatabase } from "../src/db/connection.js";
import {
  ATTACHMENT_S3_MIGRATION_BATCH_SIZE,
  migrateLegacyAttachmentsToS3,
} from "../src/services/attachment-migration.js";
import { createAttachmentStore, type S3AttachmentConfig } from "../src/services/attachment-store.js";

/** Fixed advisory-lock key for this migration (issue #1664). */
const MIGRATION_LOCK_KEY = 1664001;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function readS3ConfigFromEnv(): S3AttachmentConfig {
  return {
    endpoint: process.env.FIRST_TREE_S3_ENDPOINT?.trim() || undefined,
    region: requiredEnv("FIRST_TREE_S3_REGION"),
    bucket: requiredEnv("FIRST_TREE_S3_BUCKET"),
    accessKeyId: requiredEnv("FIRST_TREE_S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("FIRST_TREE_S3_SECRET_ACCESS_KEY"),
    forcePathStyle: ["1", "true", "yes"].includes((process.env.FIRST_TREE_S3_FORCE_PATH_STYLE ?? "").toLowerCase()),
  };
}

async function main() {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const s3Config = readS3ConfigFromEnv();

  const db = connectDatabase(databaseUrl);
  const store = createAttachmentStore(s3Config);

  const [lockRow] = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS locked`,
  );
  if (!lockRow?.locked) {
    console.error("Another migrate-attachments-to-s3 run holds the advisory lock — aborting.");
    await db.end();
    process.exit(1);
  }

  try {
    console.log(
      `Migrating legacy bytea attachments to s3://${s3Config.bucket} (batches of ${ATTACHMENT_S3_MIGRATION_BATCH_SIZE})...`,
    );
    const summary = await migrateLegacyAttachmentsToS3(db, store, {
      onProgress: (p) => console.log(`  progress: scanned=${p.scanned} migrated=${p.migrated} failed=${p.failed}`),
    });
    console.log("");
    console.log(`Done. scanned=${summary.scanned} migrated=${summary.migrated} failed=${summary.failed}`);
    if (summary.failed > 0) {
      console.log("Failed rows kept their bytea — rerun this script to resume.");
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
