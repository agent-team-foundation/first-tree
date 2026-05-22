/**
 * Path-resolution + spawn helpers shared between the GitHub Scan CLI
 * dispatcher and the daemon's HTTP server. The implementation package is
 * `private: true`, so resolution must work both when running from the
 * workspace package and after tsdown inlines it into `first-tree/dist/index.js`.
 */

import {
  type SpawnOptions,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePackageRootViaRequire(startUrl: string): string | null {
  try {
    const requireFn = createRequire(startUrl);
    return dirname(requireFn.resolve("@first-tree/github-scan/package.json"));
  } catch {
    return null;
  }
}

function walkUpFor(
  startUrl: string,
  predicate: (dir: string) => boolean,
): string | null {
  let dir = dirname(fileURLToPath(startUrl));
  while (true) {
    if (predicate(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveFirstTreePackageRoot(
  startUrl: string = import.meta.url,
): string {
  const dev = resolvePackageRootViaRequire(startUrl);
  if (dev !== null) return dev;
  const prod = walkUpFor(startUrl, (dir) =>
    existsSync(join(dir, "assets", "dashboard.html")),
  );
  if (prod !== null) return prod;
  throw new Error(
    "Could not locate the @first-tree/github-scan package root; neither workspace resolution nor bundled-asset lookup succeeded.",
  );
}

export function resolveStatuslineBundlePath(
  startUrl: string = import.meta.url,
): string {
  const dev = resolvePackageRootViaRequire(startUrl);
  if (dev !== null) {
    const candidate = join(dev, "dist", "github-scan-statusline.js");
    if (existsSync(candidate)) return candidate;
  }
  const prod = walkUpFor(startUrl, (dir) =>
    existsSync(join(dir, "github-scan-statusline.js")),
  );
  if (prod !== null) return join(prod, "github-scan-statusline.js");
  throw new Error(
    "Could not locate github-scan-statusline.js; run `pnpm build` first.",
  );
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
      `first-tree github scan: failed to spawn \`${command}\`: ${err.message}\n`,
    );
    return 1;
  }
  if (typeof result.status === "number") return result.status;
  if (result.signal) return 1;
  return 0;
}
