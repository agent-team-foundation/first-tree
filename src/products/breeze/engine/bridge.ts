/**
 * Thin process-spawn helpers used by the breeze CLI.
 *
 * Phase 8 retired the `breeze-runner` Rust binary and its resolution
 * helpers. What remains:
 *   - `resolveFirstTreePackageRoot` — locate the npm package root so
 *     callers can find bundled assets (statusline dist bundle, setup
 *     script).
 *   - `resolveBreezeSetupScript` — path to the `first-tree-breeze/setup`
 *     bash installer (still wrapped as `first-tree breeze install`).
 *   - `spawnInherit` — synchronous spawn with inherited stdio.
 */

import {
  type SpawnOptions,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FileExistsFn = (path: string) => boolean;

/**
 * Walk up from the current module until we find the npm package root
 * (the directory containing the package.json whose `name` is
 * `first-tree`).
 *
 * We can't reuse `resolveBundledPackageRoot` from the tree product
 * because that one gates on the tree SKILL.md existing, which is a
 * tree-product concern.
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

/**
 * Resolve the breeze setup script bundled under
 * `first-tree-breeze/setup`. Still a bash script.
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
 * Spawn `command args` synchronously with inherited stdio, propagating
 * the child's exit code (or remapping a signal termination to 1 as a
 * safe fallback).
 */
export function spawnInherit(
  command: string,
  args: readonly string[],
  deps: SpawnTargetDeps = {},
): number {
  const spawn: SpawnFn = deps.spawn ?? (spawnSync as SpawnFn);
  const result = spawn(command, args, { stdio: "inherit" });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    process.stderr.write(
      `first-tree breeze: failed to spawn \`${command}\`: ${err.message}\n`,
    );
    return 1;
  }
  if (typeof result.status === "number") return result.status;
  if (result.signal) return 1;
  return 0;
}
