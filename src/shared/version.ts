/**
 * Shared helper for reading VERSION files owned by a module.
 *
 * Every product and meta command carries its own VERSION file next to
 * its source `cli.ts`. These files are not bundled into `dist/` — so
 * when the CLI runs from the published package we still resolve back
 * into the source tree to read them. This helper consolidates the
 * per-module probing logic that would otherwise be copy-pasted across
 * every product dispatcher.
 *
 * Usage from a product CLI:
 *
 *     import { readOwnVersion } from "#shared/version.js";
 *     const version = readOwnVersion(import.meta.url, "src/products/gardener");
 *
 * The second argument is the repo-root-relative directory that owns
 * the VERSION file. We first try `here/VERSION` (useful if VERSION ever
 * ships alongside the dist output), then walk upward looking for a
 * directory that contains `sourceRelativeDir/VERSION`. That handles
 * both source (`tsx`, tests) and bundled (`dist/cli.js`) execution.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from the caller module looking for the named npm package's
 * package.json and return its `version` field. Returns `"unknown"` if
 * no matching package.json is found.
 */
export function readPackageVersion(
  importMetaUrl: string,
  packageName: string,
): string {
  let dir = dirname(fileURLToPath(importMetaUrl));
  while (true) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === packageName && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "unknown";
    }
    dir = parent;
  }
}

export function readOwnVersion(
  importMetaUrl: string,
  sourceRelativeDir: string,
): string {
  const here = dirname(fileURLToPath(importMetaUrl));

  const sibling = join(here, "VERSION");
  if (existsSync(sibling)) {
    try {
      return readFileSync(sibling, "utf-8").trim();
    } catch {
      // fall through to walk-up probe
    }
  }

  let dir = here;
  while (true) {
    const candidate = join(dir, sourceRelativeDir, "VERSION");
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, "utf-8").trim();
      } catch {
        // fall through to keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "unknown";
    }
    dir = parent;
  }
}
