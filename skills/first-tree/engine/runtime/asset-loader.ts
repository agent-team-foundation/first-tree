import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKILL_NAME = "first-tree";
export const SKILL_ROOT = join("skills", SKILL_NAME);
export const SKILL_AGENTS_DIR = join(SKILL_ROOT, "agents");
export const SKILL_REFERENCES_DIR = join(SKILL_ROOT, "references");
export const FRAMEWORK_ASSET_ROOT = join(SKILL_ROOT, "assets", "framework");
export const FRAMEWORK_MANIFEST = join(FRAMEWORK_ASSET_ROOT, "manifest.json");
export const FRAMEWORK_VERSION = join(FRAMEWORK_ASSET_ROOT, "VERSION");
export const FRAMEWORK_TEMPLATES_DIR = join(FRAMEWORK_ASSET_ROOT, "templates");
export const FRAMEWORK_WORKFLOWS_DIR = join(FRAMEWORK_ASSET_ROOT, "workflows");
export const FRAMEWORK_PROMPTS_DIR = join(FRAMEWORK_ASSET_ROOT, "prompts");
export const FRAMEWORK_EXAMPLES_DIR = join(FRAMEWORK_ASSET_ROOT, "examples");
export const FRAMEWORK_HELPERS_DIR = join(FRAMEWORK_ASSET_ROOT, "helpers");
export const INSTALLED_PROGRESS = join(SKILL_ROOT, "progress.md");

export const LEGACY_SKILL_NAME = "first-tree-cli-framework";
export const LEGACY_SKILL_ROOT = join("skills", LEGACY_SKILL_NAME);
export const LEGACY_SKILL_ASSET_ROOT = join(
  LEGACY_SKILL_ROOT,
  "assets",
  "framework",
);
export const LEGACY_SKILL_VERSION = join(LEGACY_SKILL_ASSET_ROOT, "VERSION");
export const LEGACY_SKILL_TEMPLATES_DIR = join(
  LEGACY_SKILL_ASSET_ROOT,
  "templates",
);
export const LEGACY_SKILL_WORKFLOWS_DIR = join(
  LEGACY_SKILL_ASSET_ROOT,
  "workflows",
);
export const LEGACY_SKILL_PROMPTS_DIR = join(
  LEGACY_SKILL_ASSET_ROOT,
  "prompts",
);
export const LEGACY_SKILL_EXAMPLES_DIR = join(
  LEGACY_SKILL_ASSET_ROOT,
  "examples",
);
export const LEGACY_SKILL_PROGRESS = join(LEGACY_SKILL_ROOT, "progress.md");

export const LEGACY_FRAMEWORK_ROOT = ".context-tree";
export const LEGACY_VERSION = join(LEGACY_FRAMEWORK_ROOT, "VERSION");
export const LEGACY_PROGRESS = join(LEGACY_FRAMEWORK_ROOT, "progress.md");
export const LEGACY_TEMPLATES_DIR = join(LEGACY_FRAMEWORK_ROOT, "templates");
export const LEGACY_WORKFLOWS_DIR = join(LEGACY_FRAMEWORK_ROOT, "workflows");
export const LEGACY_PROMPTS_DIR = join(LEGACY_FRAMEWORK_ROOT, "prompts");
export const LEGACY_EXAMPLES_DIR = join(LEGACY_FRAMEWORK_ROOT, "examples");

export type FrameworkLayout = "skill" | "legacy-skill" | "legacy";

function pathExists(root: string, relPath: string): boolean {
  const fullPath = join(root, relPath);
  try {
    return existsSync(fullPath);
  } catch {
    return false;
  }
}

export function frameworkVersionCandidates(): string[] {
  return [FRAMEWORK_VERSION, LEGACY_SKILL_VERSION, LEGACY_VERSION];
}

export function progressFileCandidates(): string[] {
  return [INSTALLED_PROGRESS, LEGACY_SKILL_PROGRESS, LEGACY_PROGRESS];
}

export function frameworkTemplateDirCandidates(): string[] {
  return [
    FRAMEWORK_TEMPLATES_DIR,
    LEGACY_SKILL_TEMPLATES_DIR,
    LEGACY_TEMPLATES_DIR,
  ];
}

export function frameworkWorkflowDirCandidates(): string[] {
  return [
    FRAMEWORK_WORKFLOWS_DIR,
    LEGACY_SKILL_WORKFLOWS_DIR,
    LEGACY_WORKFLOWS_DIR,
  ];
}

export function frameworkPromptDirCandidates(): string[] {
  return [
    FRAMEWORK_PROMPTS_DIR,
    LEGACY_SKILL_PROMPTS_DIR,
    LEGACY_PROMPTS_DIR,
  ];
}

export function frameworkExampleDirCandidates(): string[] {
  return [
    FRAMEWORK_EXAMPLES_DIR,
    LEGACY_SKILL_EXAMPLES_DIR,
    LEGACY_EXAMPLES_DIR,
  ];
}

export function resolveFirstExistingPath(
  root: string,
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    if (pathExists(root, candidate)) {
      return candidate;
    }
  }
  return null;
}

export function detectFrameworkLayout(root: string): FrameworkLayout | null {
  if (pathExists(root, FRAMEWORK_VERSION)) {
    return "skill";
  }
  if (pathExists(root, LEGACY_SKILL_VERSION)) {
    return "legacy-skill";
  }
  if (pathExists(root, LEGACY_VERSION)) {
    return "legacy";
  }
  return null;
}

export function isDirectory(root: string, relPath: string): boolean {
  try {
    return statSync(join(root, relPath)).isDirectory();
  } catch {
    return false;
  }
}
