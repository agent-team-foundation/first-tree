#!/usr/bin/env node

import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_ROOT = resolve(SCRIPT_DIR, "..");
const REQUIRED_SKILL_NAMES = [
  "first-tree",
  "first-tree-context",
  "first-tree-onboarding",
  "first-tree-sync",
  "first-tree-write",
];

function assertDirectory(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!statSync(path).isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

function resolveStagingPaths(options = {}) {
  const cliRoot = resolve(options.cliRoot ?? DEFAULT_CLI_ROOT);
  const repoRoot = resolve(options.repoRoot ?? resolve(cliRoot, "../.."));
  const sourceSkillsRoot = resolve(options.sourceSkillsRoot ?? resolve(repoRoot, "skills"));
  const targetSkillsRoot = resolve(options.targetSkillsRoot ?? resolve(cliRoot, "skills"));

  return {
    cliRoot,
    repoRoot,
    sourceSkillsRoot,
    targetSkillsRoot,
  };
}

function validateSkillPayload(root, label) {
  assertDirectory(root, label);

  for (const skillName of REQUIRED_SKILL_NAMES) {
    assertFile(resolve(root, skillName, "SKILL.md"), `${label} ${skillName}/SKILL.md`);
  }
}

function stageBundledSkills(options = {}) {
  const logger = options.logger ?? console;
  const paths = resolveStagingPaths(options);

  if (paths.sourceSkillsRoot === paths.targetSkillsRoot) {
    throw new Error(`Refusing to stage skills because source and target are the same path: ${paths.sourceSkillsRoot}`);
  }

  validateSkillPayload(paths.sourceSkillsRoot, "source skills root");

  logger.info(
    `[stage-bundled-skills] staging bundled skills from ${paths.sourceSkillsRoot} to ${paths.targetSkillsRoot}`,
  );

  rmSync(paths.targetSkillsRoot, { recursive: true, force: true });
  cpSync(paths.sourceSkillsRoot, paths.targetSkillsRoot, { recursive: true, dereference: false });

  validateSkillPayload(paths.targetSkillsRoot, "staged skills root");

  logger.info(`[stage-bundled-skills] staged ${REQUIRED_SKILL_NAMES.length} bundled skills`);

  return {
    ...paths,
    skillNames: [...REQUIRED_SKILL_NAMES],
  };
}

function isDirectRun() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    stageBundledSkills();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stage-bundled-skills] failed: ${message}`);
    process.exitCode = 1;
  }
}

export { REQUIRED_SKILL_NAMES, stageBundledSkills };
