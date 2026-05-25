#!/usr/bin/env node
// Sync packages/server/drizzle/LATEST with the last entry in _journal.json.
//
// Called automatically from `pnpm --filter @first-tree/server db:generate` so
// every freshly generated migration also bumps the LATEST sentinel. The
// sentinel is the merge-time anchor: every migration PR rewrites the same
// single line, which forces git to report a modify/modify conflict if two
// PRs try to land migrations against the same base. See
// scripts/check-migrations.mjs for the CI-side validation.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const journalPath = resolve(repoRoot, "packages/server/drizzle/meta/_journal.json");
const latestPath = resolve(repoRoot, "packages/server/drizzle/LATEST");

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const lastEntry = journal.entries?.at(-1);
if (!lastEntry?.tag) {
  console.error("sync-migration-head: _journal.json has no entries — nothing to sync.");
  process.exit(1);
}

writeFileSync(latestPath, `${lastEntry.tag}\n`);
console.log(`sync-migration-head: LATEST -> ${lastEntry.tag}`);
