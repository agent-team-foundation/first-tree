/**
 * TS port of `Service::cleanup` in `service.rs:197-207`.
 *
 * Runs `ThreadStore.cleanupOldWorkspaces` + `cleanupExpiredClaims` and
 * prints the removed paths.
 */

import { cleanupExpiredClaims } from "../daemon/claim.js";
import { resolveAutoPaths } from "../runtime/paths.js";
import { resolveRunnerHome } from "../daemon/runner-skeleton.js";
import { ThreadStore } from "../daemon/thread-store.js";

export interface RunCleanupOptions {
  write?: (line: string) => void;
  runnerHome?: string;
  /** Workspace TTL in seconds (default 2 days, matches Rust default). */
  workspaceTtlSec?: number;
}

export async function runCleanup(
  argv: readonly string[] = [],
  options: RunCleanupOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const home = options.runnerHome ?? parseHome(argv) ?? resolveRunnerHome();
  const ttl = options.workspaceTtlSec ?? parseTtl(argv) ?? 48 * 3_600;
  const store = new ThreadStore({ runnerHome: home });
  const paths = resolveAutoPaths();

  const removed = store.cleanupOldWorkspaces(ttl, []);
  const clearedClaims = cleanupExpiredClaims(paths.claimsDir);

  write(`removed ${removed.length} stale workspaces`);
  for (const path of removed) write(`- ${path}`);
  write(`cleared ${clearedClaims} expired claim(s)`);
  return 0;
}

function parseHome(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--home") return argv[i + 1];
    if (a?.startsWith("--home=")) return a.slice("--home=".length);
  }
  return undefined;
}

function parseTtl(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workspace-ttl-secs") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
    if (a?.startsWith("--workspace-ttl-secs=")) {
      const n = Number.parseInt(a.slice("--workspace-ttl-secs=".length), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
}
