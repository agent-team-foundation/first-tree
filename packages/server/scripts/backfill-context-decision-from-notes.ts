/**
 * CLI wrapper for the impact-note backfill. All logic lives in
 * `src/services/context-tree/influence-backfill.ts`.
 *
 * DRY RUN BY DEFAULT — pass `--apply` to write.
 *
 * `--since` and `--until` are REQUIRED and bound the one historical gap this
 * repair exists to close. Without them a later run could rewrite messages
 * outside that gap, including rows the write path deliberately left
 * receipt-free, making this a second permanent authority over message history.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @first-tree/server exec tsx \
 *     scripts/backfill-context-decision-from-notes.ts \
 *     --since 2026-08-06T00:00:00Z --until 2026-08-11T00:00:00Z \
 *     [--apply] [--org ORG_ID] [--all-orgs] [--max-rows N]
 */

import { connectDatabase } from "../src/db/connection.js";
import { backfillContextDecisionFromNotes } from "../src/services/context-tree/influence-backfill.js";

/**
 * Read an option's value, rejecting a missing one.
 *
 * `--org` as the final argument used to yield `undefined`, which silently
 * widened a single-org repair to EVERY organization. Combined with `--apply`
 * that is the highest-consequence typo this command can carry, so a flag
 * present without a value is an error rather than a fallback.
 */
function optionValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requiredDate(argv: readonly string[], flag: string): Date {
  const raw = optionValue(argv, flag);
  if (raw === undefined) throw new Error(`${flag} is required (the historical gap must be bounded explicitly)`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${flag} must be an ISO-8601 timestamp, got "${raw}"`);
  return parsed;
}

function parseArgs(argv: readonly string[]) {
  const apply = argv.includes("--apply");
  const organizationId = optionValue(argv, "--org");
  const allOrgs = argv.includes("--all-orgs");
  if (!organizationId && !allOrgs) {
    throw new Error("Pass --org <ORG_ID>, or --all-orgs to acknowledge a deliberately global run");
  }
  if (organizationId && allOrgs) throw new Error("Pass either --org or --all-orgs, not both");

  const maxRowsRaw = optionValue(argv, "--max-rows");
  const maxRows = maxRowsRaw === undefined ? undefined : Number(maxRowsRaw);
  if (maxRows !== undefined && (!Number.isFinite(maxRows) || maxRows <= 0)) {
    throw new Error("--max-rows must be a positive number");
  }

  return {
    apply,
    since: requiredDate(argv, "--since"),
    until: requiredDate(argv, "--until"),
    ...(organizationId ? { organizationId } : {}),
    ...(maxRows !== undefined ? { maxRows } : {}),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const options = parseArgs(process.argv.slice(2));

  // Print the exact bounds BEFORE touching anything, so an operator running
  // with --apply sees the blast radius they actually asked for.
  console.log(options.apply ? "APPLYING" : "DRY RUN (pass --apply to write)");
  console.log(`  window : ${options.since.toISOString()} .. ${options.until.toISOString()}`);
  console.log(`  scope  : ${options.organizationId ?? "ALL ORGANIZATIONS (--all-orgs)"}`);

  const db = connectDatabase(databaseUrl);
  const report = await backfillContextDecisionFromNotes(db, options);

  console.log(`  candidates scanned  : ${report.scanned}`);
  console.log(`  receipts derived    : ${report.tally.derived}`);
  console.log(`  no parsable note    : ${report.tally.no_note}`);
  console.log(`  more than one note  : ${report.tally.two_notes}`);
  console.log(`  note not convertible: ${report.tally.unconvertible}`);
  console.log(`  body not text       : ${report.tally.not_text}`);
  if (report.stoppedAtMaxRows) {
    console.log("  STOPPED at --max-rows before the window was exhausted; rerun to continue.");
  }
  if (report.unconvertibleSample.length > 0) {
    console.log(`  sample unconvertible message ids: ${report.unconvertibleSample.join(", ")}`);
  }

  await db.end();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
