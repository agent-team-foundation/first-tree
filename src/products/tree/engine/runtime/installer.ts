import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_SKILL_ROOT,
  CLAUDE_SKILL_ROOT,
  INSTALLED_SKILL_ROOTS,
  LEGACY_REPO_SKILL_ROOT,
  SKILL_ROOT,
  TREE_VERSION,
} from "#products/tree/engine/runtime/asset-loader.js";

export function resolveBundledPackageRoot(startUrl = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  while (true) {
    if (
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, BUNDLED_SKILL_ROOT, "SKILL.md"))
    ) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(
    "Could not locate the bundled `first-tree` package root. Reinstall the package and try again.",
  );
}

export function resolveCanonicalSkillRoot(sourceRoot: string): string {
  const directSkillRoot = sourceRoot;
  if (
    existsSync(join(directSkillRoot, "SKILL.md")) &&
    existsSync(join(directSkillRoot, "VERSION"))
  ) {
    return directSkillRoot;
  }

  const nestedSkillRoot = join(sourceRoot, BUNDLED_SKILL_ROOT);
  if (
    existsSync(join(nestedSkillRoot, "SKILL.md")) &&
    existsSync(join(nestedSkillRoot, "VERSION"))
  ) {
    return nestedSkillRoot;
  }

  throw new Error(
    `Canonical skill not found under ${sourceRoot}. Reinstall the \`first-tree\` package and try again.`,
  );
}

export function resolveBundledAssetRoot(sourceRoot: string): string {
  return join(sourceRoot, "assets", "tree");
}

export function resolveCanonicalFrameworkRoot(sourceRoot: string): string {
  return join(sourceRoot, "assets", "tree");
}

export function readCanonicalFrameworkVersion(sourceRoot: string): string {
  const versionPath = join(resolveCanonicalFrameworkRoot(sourceRoot), "VERSION");
  return readFileSync(versionPath, "utf-8").trim();
}

export function readSkillVersion(sourceRoot: string): string {
  const skillRoot = resolveCanonicalSkillRoot(sourceRoot);
  return readFileSync(join(skillRoot, "VERSION"), "utf-8").trim();
}

/**
 * Remove every known installed-skill location from `targetRoot`. Used by
 * the wipe-and-replace upgrade flow before installing a fresh lightweight
 * skill payload. Safe to call when nothing is installed.
 *
 * Returns the list of paths that were actually removed (relative to
 * targetRoot) so callers can report what changed.
 */
export function wipeInstalledSkill(targetRoot: string): string[] {
  const removed: string[] = [];
  const candidates = [
    SKILL_ROOT, // .agents/skills/first-tree/
    CLAUDE_SKILL_ROOT, // .claude/skills/first-tree/
    LEGACY_REPO_SKILL_ROOT, // skills/first-tree/ (legacy)
    ".context-tree", // oldest legacy layout
  ];
  for (const relPath of candidates) {
    const fullPath = join(targetRoot, relPath);
    if (existsSync(fullPath) || isSymlink(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true });
      removed.push(relPath);
    }
  }
  return removed;
}

export function copyCanonicalSkill(sourceRoot: string, targetRoot: string): void {
  const src = resolveCanonicalSkillRoot(sourceRoot);
  const sourceRepoSkillRoot = join(targetRoot, BUNDLED_SKILL_ROOT);
  const useSourceRepoAliases = resolve(sourceRepoSkillRoot) === resolve(src);
  for (const relPath of [
    ...INSTALLED_SKILL_ROOTS,
    ...(useSourceRepoAliases ? [] : [LEGACY_REPO_SKILL_ROOT]),
  ]) {
    const fullPath = join(targetRoot, relPath);
    if (existsSync(fullPath) || isSymlink(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true });
    }
  }
  const primaryDst = join(targetRoot, SKILL_ROOT);
  mkdirSync(dirname(primaryDst), { recursive: true });
  if (useSourceRepoAliases) {
    const relTarget = relative(dirname(primaryDst), src);
    symlinkSync(relTarget, primaryDst);
  } else {
    cpSync(src, primaryDst, { recursive: true });
  }

  const symlinkDst = join(targetRoot, CLAUDE_SKILL_ROOT);
  mkdirSync(dirname(symlinkDst), { recursive: true });
  const relTarget = relative(dirname(symlinkDst), primaryDst);
  symlinkSync(relTarget, symlinkDst);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function writeTreeRuntimeVersion(targetRoot: string, version: string): void {
  const dst = join(targetRoot, TREE_VERSION);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${version.trim()}\n`);
}

export function renderTemplateFile(
  frameworkRoot: string,
  templateName: string,
  targetRoot: string,
  targetPath: string,
): boolean {
  const src = join(frameworkRoot, "templates", templateName);
  const dst = join(targetRoot, targetPath);
  if (existsSync(dst) || !existsSync(src)) {
    return false;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return true;
}
