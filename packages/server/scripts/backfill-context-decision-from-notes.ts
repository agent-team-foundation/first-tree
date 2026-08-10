/**
 * CLI wrapper for the impact-note backfill. All logic lives in
 * `src/services/context-tree/influence-backfill.ts`.
 *
 * DRY RUN BY DEFAULT — pass `--apply` to write.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @first-tree/server exec tsx \
 *     scripts/backfill-context-decision-from-notes.ts [--apply] [--limit N] [--org ORG_ID]
 */

import { connectDatabase } from "../src/db/connection.js";
import { backfillContextDecisionFromNotes } from "../src/services/context-tree/influence-backfill.js";

function parseArgs(argv: readonly string[]) {
  const apply = argv.includes("--apply");
  const limitIndex = argv.indexOf("--limit");
  const orgIndex = argv.indexOf("--org");
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 5_000;
  const organizationId = orgIndex >= 0 ? argv[orgIndex + 1] : undefined;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive number");
  return { apply, limit, organizationId };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const options = parseArgs(process.argv.slice(2));
  const db = connectDatabase(databaseUrl);
  const report = await backfillContextDecisionFromNotes(db, options);

  console.log(options.apply ? "APPLIED" : "DRY RUN (pass --apply to write)");
  const hitLimit = report.scanned === options.limit ? " (hit --limit, rerun for more)" : "";
  console.log(`  candidates scanned  : ${report.scanned}${hitLimit}`);
  console.log(`  receipts derived    : ${report.tally.derived}`);
  console.log(`  no parsable note    : ${report.tally.no_note}`);
  console.log(`  more than one note  : ${report.tally.two_notes}`);
  console.log(`  note not convertible: ${report.tally.unconvertible}`);
  console.log(`  body not text       : ${report.tally.not_text}`);
  if (report.unconvertibleSample.length > 0) {
    console.log(`  sample unconvertible message ids: ${report.unconvertibleSample.join(", ")}`);
  }

  await db.end();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
