import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FRAMEWORK_ASSET_ROOT,
  FRAMEWORK_TEMPLATES_DIR,
  LEGACY_FRAMEWORK_ROOT,
  SKILL_ROOT,
} from "#skill/engine/runtime/asset-loader.js";

export function copyCanonicalSkill(sourceRoot: string, targetRoot: string): void {
  const src = join(sourceRoot, SKILL_ROOT);
  const dst = join(targetRoot, SKILL_ROOT);
  if (existsSync(dst)) {
    rmSync(dst, { recursive: true, force: true });
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

export function copyLegacyFrameworkMirror(
  sourceRoot: string,
  targetRoot: string,
): void {
  const src = join(sourceRoot, FRAMEWORK_ASSET_ROOT);
  const dst = join(targetRoot, LEGACY_FRAMEWORK_ROOT);
  if (existsSync(dst)) {
    rmSync(dst, { recursive: true, force: true });
  }
  cpSync(src, dst, { recursive: true });
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

export function sourceFrameworkTemplateRoot(root: string): string {
  return join(root, FRAMEWORK_TEMPLATES_DIR);
}
