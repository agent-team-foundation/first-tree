#!/usr/bin/env node
/**
 * Check that the version sources agree:
 *   1. package.json `version`              — full major.minor.patch (CLI)
 *   2. assets/tree/VERSION                 — full major.minor.patch (tree product)
 *   3. skills/first-tree/VERSION                 — major.minor only (tree skill payload)
 *   4. src/products/tree/VERSION           — full major.minor.patch (tree product)
 *
 * The first two and the fourth must be identical. The third must equal the
 * major.minor of those. Exits 1 on mismatch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgFile = join(root, "package.json");
const cliVersionFile = join(root, "assets/tree/VERSION");
const skillVersionFile = join(root, "skills/first-tree/VERSION");
const productVersionFile = join(root, "src/products/tree/VERSION");

const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
const cliVersion = readFileSync(cliVersionFile, "utf-8").trim();
const skillVersion = readFileSync(skillVersionFile, "utf-8").trim();
const productVersion = readFileSync(productVersionFile, "utf-8").trim();

function majorMinor(version) {
  const parts = version.split(".");
  if (parts.length < 2) return version;
  return `${parts[0]}.${parts[1]}`;
}

const errors = [];

if (pkg.version !== cliVersion) {
  errors.push(
    `package.json version (${pkg.version}) does not match assets/tree/VERSION (${cliVersion}).`,
  );
}

if (pkg.version !== productVersion) {
  errors.push(
    `package.json version (${pkg.version}) does not match src/products/tree/VERSION (${productVersion}).`,
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
    "Update all four so package.json + assets/tree/VERSION + src/products/tree/VERSION carry the full version, and skills/first-tree/VERSION carries just major.minor.",
  );
  process.exit(1);
}

console.log(
  `Versions match: CLI ${cliVersion}, product ${productVersion}, skill ${skillVersion}`,
);
