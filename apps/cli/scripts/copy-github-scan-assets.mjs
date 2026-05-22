#!/usr/bin/env node
// Copy @first-tree/github-scan runtime assets into apps/cli/dist/ so the
// published first-tree tarball is self-contained. The implementation package
// is inlined into dist/index.js by tsdown, but its file-system assets are not.

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_CLI_ROOT = resolve(HERE, "..");
const PACKAGE_ROOT = resolve(APPS_CLI_ROOT, "..", "..", "packages", "github-scan");
const SKILLS_ROOT = resolve(APPS_CLI_ROOT, "..", "..", "skills");
const DIST = join(APPS_CLI_ROOT, "dist");

if (!existsSync(DIST)) {
  console.error(
    `copy-github-scan-assets: dist/ does not exist at ${DIST}. Run \`pnpm run build\` first.`,
  );
  process.exit(1);
}

const copies = [
  ["assets/dashboard.html", "assets/dashboard.html"],
  ["README.md", "github-scan/README.md"],
  ["VERSION", "github-scan/VERSION"],
];

for (const [src, dst] of copies) {
  const srcPath = join(PACKAGE_ROOT, src);
  const dstPath = join(DIST, dst);
  if (!existsSync(srcPath)) {
    console.error(`copy-github-scan-assets: missing source ${srcPath}`);
    process.exit(1);
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  cpSync(srcPath, dstPath);
  const bytes = readFileSync(srcPath).length;
  console.log(`  copied ${src} -> dist/${dst} (${bytes} bytes)`);
}

if (!existsSync(SKILLS_ROOT)) {
  console.error(`copy-github-scan-assets: missing skills root ${SKILLS_ROOT}`);
  process.exit(1);
}

const skillsDst = join(DIST, "skills");
mkdirSync(dirname(skillsDst), { recursive: true });
cpSync(SKILLS_ROOT, skillsDst, { recursive: true });
console.log("  copied skills/ -> dist/skills/");

console.log("copy-github-scan-assets: ok");
