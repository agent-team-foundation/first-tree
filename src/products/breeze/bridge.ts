/**
 * Bridge to the existing breeze runtime.
 *
 * This module centralises two pieces of phase-1 plumbing:
 *   - resolving the `breeze-runner` Rust binary and the bundled bash scripts
 *     under `assets/breeze/bin/`
 *   - spawning either of them with inherited stdio so TTY/colour/interactive
 *     behaviour passes through unchanged
 *
 * Nothing here reinterprets user args. `first-tree breeze run --foo` must
 * result in `breeze-runner run --foo` verbatim. The dispatcher in `cli.ts`
 * picks the target and forwards the trailing argv.
 */

import {
  type SpawnOptions,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BREEZE_RUNNER_BIN_NAME = "breeze-runner";

/**
 * Name of the env var a user can set to hard-override the `breeze-runner`
 * lookup. Mirrors the `$BREEZE_RUNNER_BIN` convention already used by the
 * bash scripts.
 */
export const BREEZE_RUNNER_ENV = "BREEZE_RUNNER_BIN";

/**
 * Maintainer fallback: when `breeze-runner` is not installed globally, we
 * fall back to the locally-built binary inside the source tree. This path is
 * relative to the package root (i.e. the directory that contains this
 * package's `package.json`), not the runtime cwd.
 */
export const MAINTAINER_RUNNER_RELATIVE_PATH = join(
  "first-tree-breeze",
  "breeze-runner",
  "target",
  "release",
  BREEZE_RUNNER_BIN_NAME,
);

const INSTALLATION_HINT = `breeze-runner not found. Install with \`cd first-tree-breeze/breeze-runner && cargo install --path .\``;

export type FileExistsFn = (path: string) => boolean;
export type PathLookupFn = (binName: string) => string | null;
export type EnvReader = (name: string) => string | undefined;

export interface RunnerResolveDeps {
  env?: EnvReader;
  fileExists?: FileExistsFn;
  pathLookup?: PathLookupFn;
  packageRoot?: string;
}

export interface RunnerResolution {
  path: string;
  source: "env" | "path" | "maintainer-fallback";
}

/**
 * Walk up from the current module until we find the npm package root (the
 * directory containing the package.json whose `name` is `first-tree`).
 *
 * We can't reuse `resolveBundledPackageRoot` from the tree product because
 * that one gates on the tree SKILL.md existing, which is a tree-product
 * concern.
 */
export function resolveFirstTreePackageRoot(
  startUrl: string = import.meta.url,
): string {
  let dir = dirname(fileURLToPath(startUrl));
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === "first-tree") {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not locate the first-tree package root; the module may be installed in an unexpected layout.",
      );
    }
    dir = parent;
  }
}

function defaultPathLookup(
  binName: string,
  env: EnvReader,
  fileExists: FileExistsFn,
): string | null {
  const pathVar = env("PATH");
  if (!pathVar) {
    return null;
  }
  const pathExt = process.platform === "win32" ? (env("PATHEXT") ?? "") : "";
  const extensions =
    pathExt.length > 0
      ? pathExt.split(";").map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, ext === "" ? binName : `${binName}${ext}`);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve the `breeze-runner` binary path.
 *
 * Lookup order:
 *   1. `$BREEZE_RUNNER_BIN` (hard override; must point at an existing file)
 *   2. `which breeze-runner` on `$PATH`
 *   3. Maintainer fallback: `first-tree-breeze/breeze-runner/target/release/breeze-runner`
 *      resolved relative to the installed `first-tree` package root
 *
 * Throws a helpful error with an install hint if none of those resolve.
 */
export function resolveBreezeRunner(
  deps: RunnerResolveDeps = {},
): RunnerResolution {
  const env: EnvReader = deps.env ?? ((name) => process.env[name]);
  const fileExists: FileExistsFn = deps.fileExists ?? existsSync;
  const pathLookup: PathLookupFn =
    deps.pathLookup ??
    ((binName) => defaultPathLookup(binName, env, fileExists));

  const override = env(BREEZE_RUNNER_ENV);
  if (override && override.length > 0) {
    if (!fileExists(override)) {
      throw new Error(
        `${BREEZE_RUNNER_ENV} is set to \`${override}\` but no file exists at that path.`,
      );
    }
    return { path: override, source: "env" };
  }

  const onPath = pathLookup(BREEZE_RUNNER_BIN_NAME);
  if (onPath) {
    return { path: onPath, source: "path" };
  }

  let packageRoot: string | undefined = deps.packageRoot;
  if (packageRoot === undefined) {
    try {
      packageRoot = resolveFirstTreePackageRoot();
    } catch {
      packageRoot = undefined;
    }
  }
  if (packageRoot) {
    const fallback = join(packageRoot, MAINTAINER_RUNNER_RELATIVE_PATH);
    if (fileExists(fallback)) {
      return { path: fallback, source: "maintainer-fallback" };
    }
  }

  throw new Error(INSTALLATION_HINT);
}

/**
 * Resolve a bundled bash helper under `assets/breeze/bin/`. Used for
 * `breeze-watch`, `breeze-status-manager`, and `breeze-statusline-wrapper`.
 */
export function resolveBundledBreezeScript(
  scriptName: string,
  deps: { packageRoot?: string; fileExists?: FileExistsFn } = {},
): string {
  const fileExists = deps.fileExists ?? existsSync;
  const packageRoot = deps.packageRoot ?? resolveFirstTreePackageRoot();
  const candidate = join(packageRoot, "assets", "breeze", "bin", scriptName);
  if (!fileExists(candidate)) {
    throw new Error(
      `Bundled breeze script \`${scriptName}\` not found at ${candidate}. Reinstall first-tree.`,
    );
  }
  return candidate;
}

/**
 * Resolve the setup script that installs breeze.
 *
 * Phase 1 still sources this from `first-tree-breeze/setup`: the setup
 * script reaches into adjacent Rust / skill directories and isn't self-
 * contained enough to bundle yet. Phase 2 will rewrite it.
 */
export function resolveBreezeSetupScript(
  deps: { packageRoot?: string; fileExists?: FileExistsFn } = {},
): string {
  const fileExists = deps.fileExists ?? existsSync;
  const packageRoot = deps.packageRoot ?? resolveFirstTreePackageRoot();
  const candidate = join(packageRoot, "first-tree-breeze", "setup");
  if (!fileExists(candidate)) {
    throw new Error(
      `breeze setup script not found at ${candidate}. The \`first-tree-breeze/\` source directory is missing; reinstall or check out the repo source.`,
    );
  }
  return candidate;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnSyncReturns<Buffer>;

export interface SpawnTargetDeps {
  spawn?: SpawnFn;
}

/**
 * Spawn `command args` synchronously with inherited stdio, propagating the
 * child's exit code (or remapping a signal termination to 128 + signo,
 * matching shell conventions).
 */
export function spawnInherit(
  command: string,
  args: readonly string[],
  deps: SpawnTargetDeps = {},
): number {
  const spawn: SpawnFn = deps.spawn ?? (spawnSync as SpawnFn);
  const result = spawn(command, args, { stdio: "inherit" });

  if (result.error) {
    // Surface spawn-level errors (ENOENT, EACCES, ...) as a non-zero exit
    // code so callers can exit cleanly. The error message is already on
    // stderr when stdio is inherited, so we just add a resolver hint.
    const err = result.error as NodeJS.ErrnoException;
    process.stderr.write(
      `first-tree breeze: failed to spawn \`${command}\`: ${err.message}\n`,
    );
    return 1;
  }

  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.signal) {
    // Shell convention: 128 + signal number. We don't have the signo handy
    // in a portable way, so 1 is a safe fallback.
    return 1;
  }
  return 0;
}
