#!/usr/bin/env node
/**
 * Sync the version from skills/first-tree/assets/framework/VERSION into package.json.
 *
 * Usage:
 *   node scripts/sync-version.js          # write package.json if out of sync
 *   node scripts/sync-version.js --check  # exit 1 if out of sync (CI mode)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const check = process.argv.includes("--check");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const versionFile = join(root, "skills/first-tree/assets/framework/VERSION");
const pkgFile = join(root, "package.json");

const version = readFileSync(versionFile, "utf-8").trim();
const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));

if (pkg.version === version) {
  console.log(`package.json version already ${version}`);
} else if (check) {
  console.error(
    `Version mismatch: package.json has ${pkg.version}, VERSION has ${version}. Run \`pnpm version:sync\` to fix.`,
  );
  process.exit(1);
} else {
  pkg.version = version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`package.json version synced to ${version}`);
}
