#!/usr/bin/env node
// Migration linearity guard.
//
// Why this exists: branch protection no longer forces PRs to be up to date
// with main before merging. That removes the implicit guarantee that two
// concurrently-open PRs which each call `drizzle-kit generate` won't both
// land a migration with the same idx (e.g. two `0049_*.sql` files with
// different filename suffixes won't conflict in git, so without this check
// they'd both squash-merge cleanly and leave drizzle's _journal.json
// permanently broken on main).
//
// What it checks:
//   1. packages/server/drizzle/meta/_journal.json is contiguous and
//      well-formed (idx starts at 0, strictly increments by 1, no dup tags,
//      every entry's `tag` has the matching `NNNN_` prefix).
//   2. The on-disk .sql files and the journal agree (no orphan .sql, no
//      missing .sql for a journal entry).
//   3. packages/server/drizzle/LATEST holds the journal's last tag. This
//      sentinel is the merge-time anchor: because every migration PR
//      rewrites the same single line, two PRs that race to add a migration
//      against the same base produce a deterministic git modify/modify
//      conflict at merge time (instead of the unreliable add/add-adjacent
//      behavior that journal-append alone gives). Keep it in sync via
//      `pnpm --filter @first-tree/server db:generate`, which now invokes
//      scripts/sync-migration-head.mjs.
//   4. Every new journal entry vs. origin/main has idx > max(main idx) —
//      i.e. PRs may only append migrations, never reuse or rewrite a
//      number already on main. When the comparison base isn't available
//      (e.g. workflow_dispatch without a fetched main), the cross-branch
//      check is skipped with a warning and the local checks still run.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const drizzleDir = resolve(repoRoot, "packages/server/drizzle");
const metaDir = resolve(drizzleDir, "meta");
const journalPath = resolve(drizzleDir, "meta/_journal.json");
const journalRelPath = "packages/server/drizzle/meta/_journal.json";
const latestPath = resolve(drizzleDir, "LATEST");
const latestRelPath = "packages/server/drizzle/LATEST";
const zeroUuid = "00000000-0000-0000-0000-000000000000";

const errors = [];
const fail = (msg) => errors.push(msg);

function readJournal(source) {
  let raw;
  try {
    raw = source.read();
  } catch (err) {
    fail(`${source.label}: cannot read _journal.json (${err.message})`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`${source.label}: _journal.json is not valid JSON (${err.message})`);
    return null;
  }
  if (!Array.isArray(parsed.entries)) {
    fail(`${source.label}: _journal.json is missing an "entries" array`);
    return null;
  }
  return parsed.entries;
}

function validateContiguous(entries, label) {
  const seenTags = new Set();
  let priorIdx = -1;
  for (const entry of entries) {
    const { idx, tag } = entry;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
      fail(`${label}: entry has invalid idx ${JSON.stringify(idx)} (tag=${tag})`);
      continue;
    }
    if (typeof tag !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(tag)) {
      fail(`${label}: entry idx=${idx} has malformed tag ${JSON.stringify(tag)}`);
      continue;
    }
    const prefix = tag.slice(0, 4);
    if (parseInt(prefix, 10) !== idx) {
      fail(`${label}: entry idx=${idx} tag=${tag} — tag prefix ${prefix} does not match idx`);
    }
    if (seenTags.has(tag)) {
      fail(`${label}: duplicate tag ${tag}`);
    }
    seenTags.add(tag);
    if (idx !== priorIdx + 1) {
      fail(
        `${label}: idx sequence broken — expected ${priorIdx + 1}, got ${idx} (tag=${tag}). ` +
          "Journal must be contiguous from 0 with no gaps and no duplicates.",
      );
    }
    priorIdx = idx;
  }
}

function validateLatestSentinel(entries) {
  if (entries.length === 0) return;
  const expected = entries.at(-1).tag;
  let raw;
  try {
    raw = readFileSync(latestPath, "utf8");
  } catch (err) {
    fail(
      `${latestRelPath}: cannot read sentinel (${err.message}). ` +
        "Run `pnpm --filter @first-tree/server db:generate` to recreate it, " +
        "or `node scripts/sync-migration-head.mjs` to sync without regenerating.",
    );
    return;
  }
  const actual = raw.trim();
  if (actual !== expected) {
    fail(
      `${latestRelPath}: sentinel is "${actual}" but the journal's last tag is "${expected}". ` +
        "Run `node scripts/sync-migration-head.mjs` (or re-run `db:generate`) so the sentinel " +
        "matches the journal — this file is the merge-time anchor that forces a git conflict " +
        "when two PRs race to add a migration.",
    );
  }
}

function validateFilesMatchJournal(entries) {
  const sqlFiles = readdirSync(drizzleDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const journalTags = new Set(entries.map((e) => e.tag));
  const fileTags = new Set(sqlFiles.map((name) => name.replace(/\.sql$/, "")));

  for (const tag of journalTags) {
    if (!fileTags.has(tag)) {
      fail(`${journalRelPath} references "${tag}" but ${tag}.sql is missing on disk`);
    }
  }
  for (const tag of fileTags) {
    if (!journalTags.has(tag)) {
      fail(`packages/server/drizzle/${tag}.sql exists but is not in ${journalRelPath}`);
    }
  }
}

function validateSnapshotLinearity(entries) {
  const snapshotFiles = readdirSync(metaDir)
    .filter((name) => /^\d{4}_snapshot\.json$/.test(name))
    .sort();
  const ids = new Map();
  const prevRefs = new Map();
  const snapshots = [];

  for (const file of snapshotFiles) {
    const relPath = `packages/server/drizzle/meta/${file}`;
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(resolve(metaDir, file), "utf8"));
    } catch (err) {
      fail(`${relPath}: snapshot JSON is invalid (${err.message})`);
      continue;
    }

    const { id, prevId } = snapshot;
    if (typeof id !== "string" || id.length === 0) {
      fail(`${relPath}: snapshot id must be a non-empty string`);
    } else if (ids.has(id)) {
      fail(`${relPath}: duplicate snapshot id ${id} also used by ${ids.get(id)}`);
    } else {
      ids.set(id, relPath);
    }
    if (typeof prevId !== "string" || prevId.length === 0) {
      fail(`${relPath}: snapshot prevId must be a non-empty string`);
    } else {
      const refs = prevRefs.get(prevId) ?? [];
      refs.push(relPath);
      prevRefs.set(prevId, refs);
    }
    snapshots.push({ file, relPath, id, prevId });
  }

  for (const { relPath, prevId } of snapshots) {
    if (typeof prevId !== "string" || prevId === zeroUuid) continue;
    if (!ids.has(prevId)) {
      fail(`${relPath}: prevId ${prevId} does not match any snapshot id`);
    }
  }

  for (const [prevId, refs] of prevRefs.entries()) {
    if (refs.length <= 1) continue;
    const parent = ids.get(prevId) ?? prevId;
    fail(`${refs.join(", ")} share parent snapshot ${parent}; drizzle-kit treats this as a collision`);
  }

  const latestEntry = entries.at(-1);
  if (latestEntry) {
    const latestSnapshot = `${latestEntry.tag.slice(0, 4)}_snapshot.json`;
    if (!snapshotFiles.includes(latestSnapshot)) {
      fail(
        `packages/server/drizzle/meta/${latestSnapshot} is missing for latest migration ${latestEntry.tag}; ` +
          "without a current snapshot, `db:generate` diffs from stale history.",
      );
    }
  }
}

function readMainJournal() {
  const base = process.env.MIGRATION_CHECK_BASE_REF ?? "origin/main";
  const headSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  const baseSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", base], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  if (!baseSha) {
    console.warn(`warn: ${base} is not available locally; skipping cross-branch idx check.`);
    return { skipped: true };
  }
  if (headSha && baseSha === headSha) {
    console.log(`info: HEAD equals ${base}; cross-branch idx check is trivially satisfied.`);
    return { skipped: true };
  }
  return {
    skipped: false,
    read: () => execFileSync("git", ["show", `${base}:${journalRelPath}`], { encoding: "utf8" }),
    label: `${base}:${journalRelPath}`,
  };
}

const headEntries = readJournal({
  label: journalRelPath,
  read: () => readFileSync(journalPath, "utf8"),
});

if (headEntries) {
  validateContiguous(headEntries, journalRelPath);
  validateFilesMatchJournal(headEntries);
  validateLatestSentinel(headEntries);
  validateSnapshotLinearity(headEntries);

  const mainSource = readMainJournal();
  if (!mainSource.skipped) {
    const mainEntries = readJournal(mainSource);
    if (mainEntries) {
      const mainMaxIdx = mainEntries.length === 0 ? -1 : Math.max(...mainEntries.map((e) => e.idx));
      const mainTags = new Map(mainEntries.map((e) => [e.tag, e]));

      for (const entry of headEntries) {
        const existing = mainTags.get(entry.tag);
        if (existing) {
          if (existing.idx !== entry.idx) {
            fail(
              `tag ${entry.tag}: idx on HEAD (${entry.idx}) differs from main (${existing.idx}) — ` +
                "migrations are immutable once on main",
            );
          }
          continue;
        }
        if (entry.idx <= mainMaxIdx) {
          fail(
            `new migration ${entry.tag} has idx=${entry.idx} but main's max idx is ${mainMaxIdx}. ` +
              "Rebase onto main, delete this migration, and re-run `pnpm --filter @first-tree/server db:generate` " +
              "so it gets a fresh idx.",
          );
        }
      }

      for (const [tag, entry] of mainTags) {
        if (!headEntries.some((e) => e.tag === tag)) {
          fail(
            `migration ${tag} (idx=${entry.idx}) exists on main but is missing from HEAD — ` +
              "migrations are immutable once on main",
          );
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Migration check FAILED:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log("Migration check OK.");
