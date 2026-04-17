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
  ALL_SKILL_NAMES,
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
  const candidates: string[] = [];
  for (const skillName of ALL_SKILL_NAMES) {
    candidates.push(join(".agents", "skills", skillName));
    candidates.push(join(".claude", "skills", skillName));
  }
  candidates.push(LEGACY_REPO_SKILL_ROOT); // skills/first-tree/ (legacy)
  candidates.push(".context-tree"); // oldest legacy layout
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
  // The entry-point skill (first-tree) is the only one that must exist in
  // the source package; we fail fast here if it is missing.
  const primarySrc = resolveCanonicalSkillRoot(sourceRoot);
  const sourceRepoSkillRoot = join(targetRoot, BUNDLED_SKILL_ROOT);
  const useSourceRepoAliases =
    resolve(sourceRepoSkillRoot) === resolve(primarySrc);

  // Phase 1: wipe previously installed skill roots (and the legacy
  // vendored copy if we're not running inside the source repo). This
  // covers every skill name, not just the entry-point — otherwise an
  // upgrade from a pre-multi-skill install would leave orphaned copies
  // of the old per-product skills around.
  for (const skillName of ALL_SKILL_NAMES) {
    const agentsPath = join(targetRoot, ".agents", "skills", skillName);
    const claudePath = join(targetRoot, ".claude", "skills", skillName);
    for (const fullPath of [agentsPath, claudePath]) {
      if (existsSync(fullPath) || isSymlink(fullPath)) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }
  if (!useSourceRepoAliases) {
    const legacyPath = join(targetRoot, LEGACY_REPO_SKILL_ROOT);
    if (existsSync(legacyPath) || isSymlink(legacyPath)) {
      rmSync(legacyPath, { recursive: true, force: true });
    }
  }

  // Phase 2: install every skill the source package ships. The
  // entry-point skill is required; per-product skills are installed
  // best-effort so test fixtures and older source packages that ship
  // only the entry-point skill continue to work.
  for (const skillName of ALL_SKILL_NAMES) {
    const skillSrc =
      skillName === "first-tree"
        ? primarySrc
        : join(sourceRoot, "skills", skillName);
    if (!existsSync(join(skillSrc, "SKILL.md"))) {
      if (skillName === "first-tree") {
        throw new Error(
          `Canonical skill not found under ${sourceRoot}. Reinstall the \`first-tree\` package and try again.`,
        );
      }
      continue;
    }

    const primaryDst = join(targetRoot, ".agents", "skills", skillName);
    mkdirSync(dirname(primaryDst), { recursive: true });
    if (useSourceRepoAliases) {
      const relTarget = relative(dirname(primaryDst), skillSrc);
      symlinkSync(relTarget, primaryDst);
    } else {
      cpSync(skillSrc, primaryDst, { recursive: true });
    }

    const symlinkDst = join(targetRoot, ".claude", "skills", skillName);
    mkdirSync(dirname(symlinkDst), { recursive: true });
    const relTarget = relative(dirname(symlinkDst), primaryDst);
    symlinkSync(relTarget, symlinkDst);
  }
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
