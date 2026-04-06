#!/usr/bin/env node
/**
 * Check that package.json and skills/first-tree/assets/framework/VERSION agree.
 * Exits 1 if they differ.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const versionFile = join(root, "skills/first-tree/assets/framework/VERSION");
const pkgFile = join(root, "package.json");

const version = readFileSync(versionFile, "utf-8").trim();
const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));

if (pkg.version === version) {
  console.log(`Versions match: ${version}`);
} else {
  console.error(
    `Version mismatch: package.json has ${pkg.version}, VERSION has ${version}. Update both to match.`,
  );
  process.exit(1);
}
