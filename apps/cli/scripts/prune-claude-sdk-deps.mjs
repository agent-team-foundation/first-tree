#!/usr/bin/env node
// Surgically remove the SDK's unused JS peer dependencies after install.
//
// Why: `@anthropic-ai/claude-agent-sdk` declares `@anthropic-ai/sdk` (~9.6MB)
// and `@modelcontextprotocol/sdk` (~5.8MB) as peerDependencies, so npm 7+
// auto-installs both (~15.4MB) on a global install. But the compiled SDK
// entry First Tree actually loads (`sdk.mjs`, the `.` export) references
// NEITHER package — it is a self-contained bundle, and `createSdkMcpServer`
// ships its own MCP implementation rather than importing the MCP SDK. First
// Tree's own code never imports either package (we only use `query()` + types
// from the bundled `.` entry). So both peers are dead weight at runtime.
//
// Scope (the safe "Tier-1" cut): we delete ONLY the two scoped root packages
// `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`. These are scoped and
// uniquely owned by the claude SDK peer chain, so removing them cannot collide
// with First Tree's own dependencies. We deliberately do NOT garbage-collect
// their now-orphaned transitive deps (hono/ajv/express/qs/…): one of them
// (`iconv-lite`) is also pulled by `@inquirer/prompts`, so a blind subtree
// delete would break the CLI's interactive editor. Leaving the orphans in
// place is harmless (~6MB dangling); recovering them safely would require a
// live-tree reachability GC, out of scope here.
//
// Self-defending (the version-drift guard): the "never referenced" property is
// a fact about the CURRENTLY installed SDK bundle, not a contract — we pin the
// SDK with `^`, so a future minor could start importing a peer at runtime.
// Before deleting a package we grep the resolved `.` entry of the installed
// `@anthropic-ai/claude-agent-sdk`; if it now references that specifier we SKIP
// the prune for it. This turns a would-be silent, global-install-only runtime
// crash into "we just didn't save the space this version".
//
// Zero-config: runs as a `postinstall` of the published package, but ONLY
// prunes for a global install (`npm install -g first-tree`) — see the
// ownership-boundary note in main(). Honors FIRST_TREE_KEEP_CLAUDE_SDK_DEPS=1
// for users who prefer the full tree. The whole body is wrapped so it NEVER
// exits non-zero — a prune failure must not break the install.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// The two scoped JS peers of `@anthropic-ai/claude-agent-sdk`. Mirrors the
// SDK's own `peerDependencies` (minus `zod`, which First Tree depends on
// directly and shares — never prune it).
const PEER_PKGS = ["@anthropic-ai/sdk", "@modelcontextprotocol/sdk"];

// Dev guard: when this runs as a workspace `postinstall` inside the first-tree
// monorepo (pnpm install during development), the peers back `tsc` against the
// SDK's `.d.ts`. Only prune in a real consumer install. Detect the source
// checkout by walking up for a `pnpm-workspace.yaml` beside an `apps/cli` — a
// published global/local install never has one above it.
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

// Locate an installed package directory by walking the node_modules chain up
// from each anchor. Pure filesystem lookup — we do NOT use require.resolve here
// because these packages ship restrictive `exports` maps that block both
// `<pkg>/package.json` and (for `@modelcontextprotocol/sdk`) the bare specifier,
// so module resolution is unreliable for them.
function findPackageDir(pkg, fromPaths) {
  for (const base of fromPaths) {
    let dir = base;
    for (;;) {
      const candidate = join(dir, "node_modules", pkg);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
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

// Resolve the `.` entry file of the installed `@anthropic-ai/claude-agent-sdk`
// (the module First Tree imports) and return its source, or null if it cannot
// be located/read. Null means "cannot verify" → callers must fail safe (keep).
function readSdkEntrySource(fromPaths) {
  const root = findPackageDir("@anthropic-ai/claude-agent-sdk", fromPaths);
  if (!root) return null;
  let entry = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const dot = pkg.exports?.["."];
    entry = (typeof dot === "object" ? dot?.default || dot?.import : dot) || pkg.module || pkg.main;
  } catch {
    /* fall through to default below */
  }
  if (!entry) entry = "sdk.mjs";
  try {
    return readFileSync(join(root, entry), "utf8");
  } catch {
    return null;
  }
}

// True when `source` imports `pkg` as a (sub)path module specifier, e.g.
// `from"@anthropic-ai/sdk"`, `require('@anthropic-ai/sdk')`,
// `import("@modelcontextprotocol/sdk/server")`. Matches a quoted specifier
// only, so unrelated string literals (`io.modelcontextprotocol/related-task`,
// a github URL) never trip it.
function bundleReferences(source, pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}(/[^"'\`]*)?["'\`]`).test(source);
}

function main() {
  if (process.env.FIRST_TREE_KEEP_CLAUDE_SDK_DEPS === "1") return;
  if (insideSourceMonorepo()) return;

  // Ownership boundary: only prune in a GLOBAL install (`npm install -g
  // first-tree`), where these peers sit in first-tree's own global root and are
  // there because of first-tree. In a non-global consumer install, npm hoists
  // them to the app's root node_modules, where another dependency may share
  // them — deleting there could break an unrelated package. npm sets
  // `npm_config_global=true` for `-g`; absent it we skip and leave them in
  // place (the only cost is forgoing the size win).
  if (process.env.npm_config_global !== "true") return;

  const anchorPaths = [process.cwd(), import.meta.dirname];

  // Self-defending guard: if the installed SDK entry references a peer at
  // runtime, do NOT prune it. If we cannot read the entry, fail safe (skip
  // everything) — never delete a package we could not prove is unused.
  const entrySource = readSdkEntrySource(anchorPaths);
  if (entrySource === null) return;

  let removedBytes = 0;
  for (const pkg of PEER_PKGS) {
    if (bundleReferences(entrySource, pkg)) {
      console.log(`[first-tree] kept ${pkg}: the installed claude SDK entry references it`);
      continue;
    }
    const root = findPackageDir(pkg, anchorPaths);
    if (!root) continue;
    try {
      const before = dirSize(root);
      rmSync(root, { recursive: true, force: true });
      removedBytes += before;
      console.log(`[first-tree] pruned unused claude SDK peer: ${pkg} (${(before / 1e6).toFixed(0)}MB)`);
    } catch {
      /* best-effort: a read-only or vanished tree is fine, the SDK never loads it */
    }
  }
  if (removedBytes > 0) {
    console.log(
      `[first-tree] removed unused claude SDK JS peers (~${(removedBytes / 1e6).toFixed(0)}MB saved); set FIRST_TREE_KEEP_CLAUDE_SDK_DEPS=1 to keep them`,
    );
  }
}

try {
  main();
} catch {
  // Never fail the install — a prune failure must not break `npm i -g`.
}
