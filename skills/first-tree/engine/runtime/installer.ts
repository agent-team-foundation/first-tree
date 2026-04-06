import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_SKILL_ROOT,
  INSTALLED_SKILL_ROOTS,
  LEGACY_REPO_SKILL_ROOT,
  TREE_VERSION,
} from "#skill/engine/runtime/asset-loader.js";

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
    existsSync(join(directSkillRoot, "assets", "framework", "VERSION"))
  ) {
    return directSkillRoot;
  }

  const nestedSkillRoot = join(sourceRoot, BUNDLED_SKILL_ROOT);
  if (
    existsSync(join(nestedSkillRoot, "SKILL.md")) &&
    existsSync(join(nestedSkillRoot, "assets", "framework", "VERSION"))
  ) {
    return nestedSkillRoot;
  }

  throw new Error(
    `Canonical skill not found under ${sourceRoot}. Reinstall the \`first-tree\` package and try again.`,
  );
}

export function resolveCanonicalFrameworkRoot(sourceRoot: string): string {
  return join(resolveCanonicalSkillRoot(sourceRoot), "assets", "framework");
}

export function readCanonicalFrameworkVersion(sourceRoot: string): string {
  const versionPath = join(resolveCanonicalFrameworkRoot(sourceRoot), "VERSION");
  return readFileSync(versionPath, "utf-8").trim();
}

export function copyCanonicalSkill(sourceRoot: string, targetRoot: string): void {
  const src = resolveCanonicalSkillRoot(sourceRoot);
  for (const relPath of [
    ...INSTALLED_SKILL_ROOTS,
    LEGACY_REPO_SKILL_ROOT,
  ]) {
    const fullPath = join(targetRoot, relPath);
    if (existsSync(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true });
    }
  }
  for (const relPath of INSTALLED_SKILL_ROOTS) {
    const dst = join(targetRoot, relPath);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
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
