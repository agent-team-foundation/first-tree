/**
 * Path-resolution + spawn helpers shared between the auto CLI dispatcher
 * and the daemon's HTTP server. `@first-tree/auto` is `private: true`,
 * so resolution must work both when running from packages/auto/ source
 * (workspace symlink) and after tsdown inlines the package into
 * first-tree/dist/index.js (no @first-tree/auto in node_modules).
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

function resolveAutoPackageRootViaRequire(startUrl: string): string | null {
  try {
    const requireFn = createRequire(startUrl);
    return dirname(requireFn.resolve("@first-tree/auto/package.json"));
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

export function resolveAutoPackageRoot(
  startUrl: string = import.meta.url,
): string {
  const dev = resolveAutoPackageRootViaRequire(startUrl);
  if (dev !== null) return dev;
  const prod = walkUpFor(startUrl, (dir) =>
    existsSync(join(dir, "assets", "dashboard.html")),
  );
  if (prod !== null) return prod;
  throw new Error(
    "Could not locate the @first-tree/auto package root; neither workspace resolution nor bundled-asset lookup succeeded.",
  );
}

export function resolveStatuslineBundlePath(
  startUrl: string = import.meta.url,
): string {
  // Dev: the bundle sits under packages/auto/dist/.
  const dev = resolveAutoPackageRootViaRequire(startUrl);
  if (dev !== null) {
    const candidate = join(dev, "dist", "auto-statusline.js");
    if (existsSync(candidate)) return candidate;
  }
  // Bundled mode: apps/cli's tsdown emits auto-statusline.js as a
  // sibling of index.js. Walk up looking for it directly.
  const prod = walkUpFor(startUrl, (dir) =>
    existsSync(join(dir, "auto-statusline.js")),
  );
  if (prod !== null) return join(prod, "auto-statusline.js");
  throw new Error(
    "Could not locate auto-statusline.js bundle; run `pnpm build` first.",
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
      `first-tree auto: failed to spawn \`${command}\`: ${err.message}\n`,
    );
    return 1;
  }
  if (typeof result.status === "number") return result.status;
  if (result.signal) return 1;
  return 0;
}
