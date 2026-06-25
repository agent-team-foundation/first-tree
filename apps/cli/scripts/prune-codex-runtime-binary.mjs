#!/usr/bin/env node
// Surgically remove the SDK-bundled native Codex engine after install.
//
// Why: the `@openai/codex-{platform}` package ships a ~225MB native `codex`
// binary as a transitive optionalDependency of `@openai/codex-sdk`. First Tree
// does not need it bundled — the runtime resolves a system `codex` on PATH
// (see packages/client/src/runtime/codex-binary.ts) and the daemon can install
// the native engine on demand (`daemon install-codex`). Removing the vendored
// binary at install time trims the install footprint without touching the
// small `@openai/codex-sdk` TypeScript client we actually import.
//
// Zero-config: runs as a `postinstall` of the published package, but ONLY
// prunes for a global install (`npm install -g first-tree`) — see the
// ownership-boundary note in main(). Honors FIRST_TREE_KEEP_CODEX_BINARY=1 for
// users who prefer the bundled engine. The whole body is wrapped so it NEVER
// exits non-zero — a prune failure must not break the install (the runtime
// degrades gracefully to PATH).
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PLATFORM_PKGS = [
  "@openai/codex-darwin-arm64",
  "@openai/codex-darwin-x64",
  "@openai/codex-linux-arm64",
  "@openai/codex-linux-x64",
  "@openai/codex-win32-arm64",
  "@openai/codex-win32-x64",
];

// Dev guard: when this runs as a workspace `postinstall` inside the first-tree
// monorepo (pnpm install during development), the bundled codex binary is the
// dev runtime we want to keep. Only prune in a real consumer install. Detect
// the source checkout by walking up for a `pnpm-workspace.yaml` beside an
// `apps/cli` — a published global/local install never has one above it.
function insideSourceMonorepo() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "apps", "cli"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function tryResolvePackageRoot(spec, fromPaths) {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve(`${spec}/package.json`, { paths: fromPaths }));
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* ignore unreadable entry */
        }
      }
    }
  }
  return total;
}

function main() {
  if (process.env.FIRST_TREE_KEEP_CODEX_BINARY === "1") return;
  if (insideSourceMonorepo()) return;

  // Ownership boundary: only prune in a GLOBAL install (`npm install -g
  // first-tree`), where the codex engine sits in first-tree's own global
  // root and is there because of first-tree. In a non-global consumer
  // install, npm hoists `@openai/codex-*` to the app's root node_modules,
  // where another dependency may share it — deleting it there could break an
  // unrelated package. npm sets `npm_config_global=true` for `-g` installs;
  // absent it (local dependency install, or a package manager that doesn't
  // export the flag) we skip and leave the binary in place. The runtime still
  // resolves a system `codex` on PATH, so skipping only forgoes the size win.
  if (process.env.npm_config_global !== "true") return;

  // Anchor resolution at both the install package dir (cwd during a
  // `postinstall`) and this script's own dir, so the node_modules walk-up
  // finds a sibling `@openai/*` in either flat (npm) or nested layouts.
  const anchorPaths = [process.cwd(), import.meta.dirname];
  let removedBytes = 0;
  for (const pkg of PLATFORM_PKGS) {
    const root = tryResolvePackageRoot(pkg, anchorPaths);
    if (!root) continue;
    try {
      const before = dirSize(root);
      rmSync(root, { recursive: true, force: true });
      removedBytes += before;
      console.log(`[first-tree] pruned bundled codex engine: ${pkg} (${(before / 1e6).toFixed(0)}MB)`);
    } catch {
      /* best-effort: a read-only or vanished tree is fine, runtime falls back to PATH */
    }
  }
  if (removedBytes > 0) {
    console.log(
      `[first-tree] codex runtime resolves from PATH or \`daemon install-codex\` (~${(removedBytes / 1e6).toFixed(0)}MB saved)`,
    );
  }
}

try {
  main();
} catch {
  // Never fail the install — the runtime degrades to PATH / one-click install.
}
