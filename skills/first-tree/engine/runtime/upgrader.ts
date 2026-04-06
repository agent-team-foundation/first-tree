import { readCanonicalFrameworkVersion } from "#skill/engine/runtime/installer.js";

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
  try {
    return readCanonicalFrameworkVersion(sourceRoot);
  } catch {
    return null;
  }
}
