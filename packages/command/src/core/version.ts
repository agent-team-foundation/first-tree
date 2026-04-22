import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version of the consumer-facing `@agent-team-foundation/first-tree-hub`
 * package. Read once at module load so the CLI, client runtime, and server
 * bootstrap all quote the same string.
 *
 * Path-based lookups (`require("../../package.json")`) do not survive the
 * tsdown bundle: the source lives at `src/core/version.ts` but every
 * emitted chunk lands in `dist/` — shifting the relative depth by one and
 * pointing at `packages/package.json` instead of our own manifest (the
 * v0.9.1 "Cannot find module ../../package.json" crash). Walk up from this
 * module's URL and accept the first `package.json` whose `name` matches, so
 * dev runs (`tsx src/cli/index.ts`) and the published bundle
 * (`dist/cli/index.mjs`) both resolve the same file.
 */
const PACKAGE_NAME = "@agent-team-foundation/first-tree-hub";

/**
 * Sentinel returned when the walker exhausts every parent directory without
 * finding our manifest. Deliberately NOT valid SemVer so the client-side
 * `UpdateManager` drops into its `semver.valid(current) === false` warn-and-
 * skip branch instead of treating it as `< target` and triggering a spurious
 * self-update loop (the scenario where the startup crash this module fixes
 * would otherwise quietly reincarnate as repeated `npm install -g @latest`).
 */
const UNRESOLVED_VERSION = "unknown";

type PartialPackageJson = { name?: string; version?: string };

/**
 * Exported for tests. Walks up from `moduleUrl`'s directory looking for a
 * `package.json` whose `name` field equals {@link PACKAGE_NAME}. Returns
 * {@link UNRESOLVED_VERSION} as a last-resort fallback so the CLI never
 * crashes on a missing manifest.
 */
export function resolveCommandVersion(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as PartialPackageJson;
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch (err) {
      // Expected at levels without a manifest — silent.
      // Any other code (EACCES on a locked-down manifest, EISDIR if the
      // path has been replaced with a directory, SyntaxError on a truncated
      // install) is unusual and would otherwise hide a real install
      // problem behind the fallback value. Warn to stderr but keep
      // walking: throwing here would reinstate the v0.9.1 startup crash
      // this module exists to prevent.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[first-tree-hub] warning: could not read ${dir}/package.json: ${message}\n`);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return UNRESOLVED_VERSION;
}

export const COMMAND_VERSION: string = resolveCommandVersion();
