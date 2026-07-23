/**
 * Operator entry point for the attachment → object-storage data migration.
 * All logic lives in src/services/attachment-migration.ts (tested there);
 * this shell resolves config the same way the server does, refuses to run
 * without object storage, and maps the verify phase onto the exit code.
 *
 * Run: pnpm --filter @first-tree/server migrate:attachments
 * (requires FIRST_TREE_DATABASE_URL + FIRST_TREE_S3_* in the environment
 * or ../../.env, exactly like the server itself)
 */

import { createServerConfigSchema, initConfig } from "@first-tree/shared/config";
import { connectDatabase } from "../src/db/connection.js";
import { migrateAttachmentsToObjectStorage } from "../src/services/attachment-migration.js";
import { createObjectStorage } from "../src/services/object-storage.js";

async function main(): Promise<void> {
  const config = await initConfig({ schema: createServerConfigSchema(), role: "server" });
  if (!config.objectStorage) {
    console.error("Object storage is not configured (FIRST_TREE_S3_*); refusing to run.");
    process.exit(1);
  }
  const db = connectDatabase(config.database.url);
  const storage = createObjectStorage(config.objectStorage);
  await storage.ensureBucket();

  try {
    const stats = await migrateAttachmentsToObjectStorage(db, storage);
    if (stats.attachmentsRemaining > 0 || stats.avatarsRemaining > 0) {
      console.error(
        `Migration incomplete: ${stats.attachmentsRemaining} attachment / ${stats.avatarsRemaining} avatar payloads still inline. Rerun this command (idempotent) and investigate.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      "Migration complete. Messages sent while the reference backfill ran may have added new references; rerunning is cheap and converges.",
    );
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
