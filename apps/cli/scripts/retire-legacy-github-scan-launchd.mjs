#!/usr/bin/env node
// npm adoption boundary for the legacy github-scan launchd retirement
// (issue #995): `npm install -g` runs postinstall from the freshly installed
// package, which is the one moment an X→Y upgrade is guaranteed to execute
// Y's code even if the operator never runs another CLI command afterwards.
// The sweep itself lives in the CLI entrypoint's preAction migration; this
// script only launches the installed CLI in cleanup-only mode. It is strictly
// best-effort: a migration problem must never turn a successful package
// install into a failed one, and users installing with --ignore-scripts are
// still covered by the preAction boundary on first use.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function insideSourceMonorepo() {
  // pnpm runs postinstall for workspace packages too; the source tree has no
  // dist bundle and developers do not want launchctl side effects from
  // `pnpm install`.
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
  const cliEntry = join(dirname(import.meta.dirname), "dist", "cli", "index.mjs");
  if (!existsSync(cliEntry)) return;

  const result = spawnSync(process.execPath, [cliEntry, "daemon", "ensure-service"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    env: {
      ...process.env,
      // ensure-service returns before credential/service work in this mode;
      // the migration has already run in that child's own preAction.
      FIRST_TREE_LEGACY_GITHUB_SCAN_ONLY: "1",
      // Never let an inherited service-mode marker make the child behave like
      // the supervised daemon.
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
