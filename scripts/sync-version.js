#!/usr/bin/env node
/**
 * Sync the version from skills/first-tree/assets/framework/VERSION into package.json.
 * Run automatically via the prepack script so npm always sees the canonical version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const versionFile = join(root, "skills/first-tree/assets/framework/VERSION");
const pkgFile = join(root, "package.json");

const version = readFileSync(versionFile, "utf-8").trim();
const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));

if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`package.json version synced to ${version}`);
} else {
  console.log(`package.json version already ${version}`);
}
