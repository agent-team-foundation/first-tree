#!/usr/bin/env node
// Copy @first-tree/auto runtime assets into apps/cli/dist/ so the
// published first-tree tarball is self-contained (the package itself is
// private + inlined into dist/index.js by tsdown, but its file-system
// assets aren't part of the JS bundle). Wired via apps/cli prepack.

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_CLI_ROOT = resolve(HERE, "..");
const PACKAGES_AUTO_ROOT = resolve(APPS_CLI_ROOT, "..", "..", "packages", "auto");
const DIST = join(APPS_CLI_ROOT, "dist");

if (!existsSync(DIST)) {
  console.error(
    `copy-auto-assets: dist/ does not exist at ${DIST}. Run \`pnpm run build\` first.`,
  );
  process.exit(1);
}

const copies = [
  ["assets/dashboard.html", "assets/dashboard.html"],
  ["assets/README.md", "assets/README.md"],
  ["skills/auto/SKILL.md", "skills/auto/SKILL.md"],
  ["skills/auto/VERSION", "skills/auto/VERSION"],
  ["VERSION", "VERSION"],
];

for (const [src, dst] of copies) {
  const srcPath = join(PACKAGES_AUTO_ROOT, src);
  const dstPath = join(DIST, dst);
  if (!existsSync(srcPath)) {
    console.error(`copy-auto-assets: missing source ${srcPath}`);
    process.exit(1);
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  cpSync(srcPath, dstPath);
  const bytes = readFileSync(srcPath).length;
  console.log(`  copied ${src} → dist/${dst} (${bytes} bytes)`);
}

console.log("copy-auto-assets: ok");
