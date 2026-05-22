/**
 * Filesystem layout for the shared `~/.first-tree/github-scan/` store.
 *
 * Mirrors `resolve_inbox_dir` (`fetcher.rs:652-657`): honors `$GITHUB_SCAN_DIR`,
 * otherwise falls back to `$HOME/.first-tree/github-scan`. The runner home is separately
 * `$GITHUB_SCAN_HOME`, defaulting to `$GITHUB_SCAN_DIR/runner` — Phase 2a does not
 * touch the runner-private tree, so those paths are intentionally absent
 * from this module.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface GitHubScanPathsDeps {
  /** Read an env var; pass `() => undefined` to force defaults. */
  env?: (name: string) => string | undefined;
  /** Home-directory override; defaults to `os.homedir()`. */
  homeDir?: () => string;
}

export interface GitHubScanPaths {
  /** The shared github-scan directory (`$GITHUB_SCAN_DIR` or `$HOME/.first-tree/github-scan`). */
  root: string;
  /** `inbox.json` path. */
  inbox: string;
  /** `activity.log` path (append-only JSONL). */
  activityLog: string;
  /** `claims/` directory (one subdirectory per notification id). */
  claimsDir: string;
  /** `identity.json` — TS-port identity cache (24h TTL). */
  identityCache: string;
  /** `inbox.json.lock` — advisory lock for concurrent writers. */
  inboxLock: string;
}

export const GITHUB_SCAN_DIR_ENV = "GITHUB_SCAN_DIR";

/** Resolve the shared `~/.first-tree/github-scan/` layout. */
export function resolveGitHubScanPaths(deps: GitHubScanPathsDeps = {}): GitHubScanPaths {
  const env = deps.env ?? ((name) => process.env[name]);
  const homeDir = deps.homeDir ?? homedir;

  const override = env(GITHUB_SCAN_DIR_ENV);
  const root = override && override.length > 0 ? override : join(homeDir(), ".first-tree/github-scan");

  return {
    root,
    inbox: join(root, "inbox.json"),
    activityLog: join(root, "activity.log"),
    claimsDir: join(root, "claims"),
    identityCache: join(root, "identity.json"),
    inboxLock: join(root, "inbox.json.lock"),
  };
}
