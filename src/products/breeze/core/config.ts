/**
 * Runtime config for breeze TS-port commands.
 *
 * Phase 2a has no `config.yaml` file yet (spec doc 4 §9 — the Rust
 * runner takes no config file today; broker/dispatcher options are CLI
 * flags + env vars only). This module simply collects the env and
 * CLI-flag knobs shared by `status-manager` and (later) the daemon
 * port so callers don't hard-code env-var names.
 */

export const CLAIM_TIMEOUT_SECS = 300; // 5 minutes; matches bin/breeze-status-manager:29

export interface BreezeConfig {
  /** GitHub API host, default "github.com". Mirrors runner `--host`. */
  host: string;
  /** Identity cache TTL for `~/.breeze/identity.json`. */
  identityTtlMs: number;
  /** How long a claim directory lives before it can be overwritten. */
  claimTimeoutSecs: number;
}

export interface LoadConfigDeps {
  env?: (name: string) => string | undefined;
}

/** Load the runtime config from env. Used by status-manager and friends. */
export function loadBreezeConfig(deps: LoadConfigDeps = {}): BreezeConfig {
  const env = deps.env ?? ((name) => process.env[name]);
  return {
    host: env("BREEZE_HOST") ?? env("GH_HOST") ?? "github.com",
    identityTtlMs: 24 * 60 * 60 * 1000,
    claimTimeoutSecs: CLAIM_TIMEOUT_SECS,
  };
}
