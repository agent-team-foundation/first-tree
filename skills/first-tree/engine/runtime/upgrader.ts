import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCanonicalSkillRoot } from "#skill/engine/runtime/installer.js";

export function compareFrameworkVersions(left: string, right: string): number {
  const result = left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (result < 0) return -1;
  if (result > 0) return 1;
  return 0;
}

export function readSourceVersion(sourceRoot: string): string | null {
  const skillRoot = resolveCanonicalSkillRoot(sourceRoot);
  const versionPath = join(skillRoot, "assets", "framework", "VERSION");
  try {
    return readFileSync(versionPath, "utf-8").trim();
  } catch {
    return null;
  }
}
