import {
  readCanonicalFrameworkVersion,
  readSkillVersion,
} from "#products/tree/engine/runtime/installer.js";

export function compareFrameworkVersions(left: string, right: string): number {
  const result = left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (result < 0) return -1;
  if (result > 0) return 1;
  return 0;
}

/**
 * Extract major.minor from a version string. Accepts both "0.2" and "0.2.3".
 * Returns the input unchanged if it's already in major.minor form.
 */
export function extractMajorMinor(version: string): string {
  const trimmed = version.trim();
  const parts = trimmed.split(".");
  if (parts.length < 2) return trimmed;
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Compare two versions at the major.minor granularity. Used for skill
 * upgrade decisions: if the installed skill's major.minor matches the
 * CLI's major.minor, the skill is up-to-date even if the patch differs.
 */
export function compareSkillVersions(
  installed: string,
  bundled: string,
): number {
  return compareFrameworkVersions(
    extractMajorMinor(installed),
    extractMajorMinor(bundled),
  );
}

export function readSourceVersion(sourceRoot: string): string | null {
  try {
    return readCanonicalFrameworkVersion(sourceRoot);
  } catch {
    return null;
  }
}

export function readBundledSkillVersion(sourceRoot: string): string | null {
  try {
    return readSkillVersion(sourceRoot);
  } catch {
    return null;
  }
}
