/**
 * Filesystem layout for the shared `~/.breeze/` store.
 *
 * Mirrors `resolve_inbox_dir` (`fetcher.rs:652-657`): honors `$BREEZE_DIR`,
 * otherwise falls back to `$HOME/.breeze`. The runner home is separately
 * `$BREEZE_HOME`, defaulting to `$BREEZE_DIR/runner` — Phase 2a does not
 * touch the runner-private tree, so those paths are intentionally absent
 * from this module.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface BreezePathsDeps {
  /** Read an env var; pass `() => undefined` to force defaults. */
  env?: (name: string) => string | undefined;
  /** Home-directory override; defaults to `os.homedir()`. */
  homeDir?: () => string;
}

export interface BreezePaths {
  /** The shared breeze directory (`$BREEZE_DIR` or `$HOME/.breeze`). */
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

export const BREEZE_DIR_ENV = "BREEZE_DIR";

/** Resolve the shared `~/.breeze/` layout. */
export function resolveBreezePaths(deps: BreezePathsDeps = {}): BreezePaths {
  const env = deps.env ?? ((name) => process.env[name]);
  const homeDir = deps.homeDir ?? homedir;

  const override = env(BREEZE_DIR_ENV);
  const root = override && override.length > 0 ? override : join(homeDir(), ".breeze");

  return {
    root,
    inbox: join(root, "inbox.json"),
    activityLog: join(root, "activity.log"),
    claimsDir: join(root, "claims"),
    identityCache: join(root, "identity.json"),
    inboxLock: join(root, "inbox.json.lock"),
  };
}
