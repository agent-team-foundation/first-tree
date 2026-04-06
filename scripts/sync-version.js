#!/usr/bin/env node
/**
 * Check that the three version sources agree:
 *   1. package.json `version`              — full major.minor.patch (CLI)
 *   2. assets/framework/VERSION            — full major.minor.patch (CLI)
 *   3. skills/first-tree/VERSION           — major.minor only (skill payload)
 *
 * The first two must be identical. The third must equal the major.minor
 * of the first two. Exits 1 on mismatch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgFile = join(root, "package.json");
const cliVersionFile = join(root, "assets/framework/VERSION");
const skillVersionFile = join(root, "skills/first-tree/VERSION");

const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
const cliVersion = readFileSync(cliVersionFile, "utf-8").trim();
const skillVersion = readFileSync(skillVersionFile, "utf-8").trim();

function majorMinor(version) {
  const parts = version.split(".");
  if (parts.length < 2) return version;
  return `${parts[0]}.${parts[1]}`;
}

const errors = [];

if (pkg.version !== cliVersion) {
  errors.push(
    `package.json version (${pkg.version}) does not match assets/framework/VERSION (${cliVersion}).`,
  );
}

if (skillVersion !== majorMinor(pkg.version)) {
  errors.push(
    `skills/first-tree/VERSION (${skillVersion}) does not match the major.minor of package.json (${majorMinor(pkg.version)}).`,
  );
}

if (errors.length > 0) {
  for (const err of errors) console.error(err);
  console.error(
    "Update all three so package.json + assets/framework/VERSION carry the full version, and skills/first-tree/VERSION carries just major.minor.",
  );
  process.exit(1);
}

console.log(
  `Versions match: CLI ${cliVersion}, skills ${skillVersion}`,
);
