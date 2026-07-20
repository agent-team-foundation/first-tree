#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Run the legacy github-scan migration from the newly installed package.
// npm executes postinstall from the package that was just installed, so this
// is the adoption-boundary hook for an old CLI (X) installing this release (Y).
// The script is deliberately best-effort: migration failure must never turn a
// successful package install into a failed upgrade.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function insideSourceMonorepo() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "apps", "cli"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function main() {
  if (insideSourceMonorepo()) return;
  const cli = join(dirname(import.meta.dirname), "dist", "cli", "index.mjs");
  if (!existsSync(cli)) return;

  const result = spawnSync(process.execPath, [cli, "daemon", "ensure-service"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    env: {
      ...process.env,
      FIRST_TREE_LEGACY_GITHUB_SCAN_ONLY: "1",
      FIRST_TREE_SERVICE_MODE: "",
    },
  });
  if (result.status !== 0) {
    const output = [String(result.stderr ?? "").trim(), String(result.stdout ?? "").trim()].filter(Boolean).join(" | ");
    console.warn(`[first-tree] legacy github-scan cleanup did not complete${output ? `: ${output}` : ""}`);
  }
}

try {
  main();
} catch (err) {
  console.warn(`[first-tree] legacy github-scan cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
}
