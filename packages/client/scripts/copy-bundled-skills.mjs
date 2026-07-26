#!/usr/bin/env node
// Copy the canonical skill payloads from the repo-root `skills/` directory
// into `packages/client/skills/` so they ship inside the @first-tree/client
// npm tarball (see the `files` field in package.json). Source of truth stays
// at `<repo>/skills/`; this directory is a build artifact (.gitignore'd).
//
// Runs in `prebuild`. Intentionally synchronous — fast, deterministic, and
// avoids pulling in an async dependency just to do a directory copy.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The skill set that ships with @first-tree/client. Kept hand-maintained
// (rather than "copy whatever exists in repo-root skills/") so that adding
// or retiring a skill is a deliberate decision visible in this commit.
//
// To add a skill: drop its directory under repo-root `skills/<name>/`, then
// add the name here. To retire one: remove it from this list AND delete the
// directory under repo-root `skills/`.
const BUNDLED_SKILLS = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
  "context-tree-review",
  "context-tree-audit",
  "first-tree-qa",
];

function findRepoRoot(startDir) {
  let currentDir = resolve(startDir);
  while (true) {
    if (existsSync(join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("Could not locate repo root (no pnpm-workspace.yaml found in any parent of this script).");
    }
    currentDir = parentDir;
  }
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const clientPkgDir = resolve(scriptDir, "..");
  const repoRoot = findRepoRoot(scriptDir);
  const sourceSkillsRoot = join(repoRoot, "skills");
  const targetSkillsRoot = join(clientPkgDir, "skills");

  if (!existsSync(sourceSkillsRoot) || !statSync(sourceSkillsRoot).isDirectory()) {
    throw new Error(`Source skills directory missing: ${sourceSkillsRoot}`);
  }

  // Wipe + recreate so retired skills disappear and dirty files do not
  // linger between builds. The wipe is bounded to the target dir we own.
  if (existsSync(targetSkillsRoot)) {
    rmSync(targetSkillsRoot, { recursive: true, force: true });
  }
  mkdirSync(targetSkillsRoot, { recursive: true });

  const missing = [];
  for (const name of BUNDLED_SKILLS) {
    const src = join(sourceSkillsRoot, name);
    if (!existsSync(src)) {
      missing.push(name);
      continue;
    }
    const dst = join(targetSkillsRoot, name);
    cpSync(src, dst, { recursive: true });
  }

  if (missing.length > 0) {
    throw new Error(
      `Source skills missing for: ${missing.join(", ")}. Either add them under ${sourceSkillsRoot}/ or remove from BUNDLED_SKILLS in this script.`,
    );
  }

  const copied = readdirSync(targetSkillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  process.stdout.write(`copy-bundled-skills: copied ${copied.length} skill(s) → ${targetSkillsRoot}\n`);
}

main();
