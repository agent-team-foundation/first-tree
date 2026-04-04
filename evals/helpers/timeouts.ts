/**
 * Centralized timeout configuration for the eval harness.
 *
 * All timeouts are configurable via environment variables (or .env file).
 * Values are in milliseconds. Each has a sensible default.
 */

import { getEnv } from '#evals/helpers/env.js';

function ms(key: string, defaultMs: number): number {
  const val = getEnv(key);
  return val ? parseInt(val, 10) : defaultMs;
}

// --- Git network operations (clone, fetch, ls-remote, push) ---

/** Full git clone from remote (cache miss). Default: 300s */
export const TIMEOUT_GIT_CLONE = ms('EVALS_TIMEOUT_GIT_CLONE', 300_000);

/** git fetch origin (cache update). Default: 120s */
export const TIMEOUT_GIT_FETCH = ms('EVALS_TIMEOUT_GIT_FETCH', 120_000);

/** git ls-remote (preflight checks). Default: 30s */
export const TIMEOUT_GIT_LS_REMOTE = ms('EVALS_TIMEOUT_GIT_LS_REMOTE', 30_000);

/** git push to remote. Default: 60s */
export const TIMEOUT_GIT_PUSH = ms('EVALS_TIMEOUT_GIT_PUSH', 60_000);

// --- Git local operations (checkout, clean, reset, copy) ---

/** git checkout (commit or branch). Default: 120s */
export const TIMEOUT_GIT_CHECKOUT = ms('EVALS_TIMEOUT_GIT_CHECKOUT', 120_000);

/** git clean -fdx. Default: 30s */
export const TIMEOUT_GIT_CLEAN = ms('EVALS_TIMEOUT_GIT_CLEAN', 30_000);

/** git reset --hard. Default: 30s */
export const TIMEOUT_GIT_RESET = ms('EVALS_TIMEOUT_GIT_RESET', 30_000);

/** cp -a (local cache copy). Default: 120s */
export const TIMEOUT_COPY = ms('EVALS_TIMEOUT_COPY', 120_000);

/** git log (local). Default: 10s */
export const TIMEOUT_GIT_LOG = ms('EVALS_TIMEOUT_GIT_LOG', 10_000);

/** git rev-parse / git status --porcelain (local). Default: 5s */
export const TIMEOUT_GIT_INFO = ms('EVALS_TIMEOUT_GIT_INFO', 5_000);

// --- Setup & build operations ---

/** Per-repo setup scripts (e.g. uv pip install). Default: 300s */
export const TIMEOUT_SETUP = ms('EVALS_TIMEOUT_SETUP', 300_000);

/** pnpm install (CLI installation). Default: 120s */
export const TIMEOUT_INSTALL = ms('EVALS_TIMEOUT_INSTALL', 120_000);

/** pnpm build && npm link (CLI build). Default: 60s */
export const TIMEOUT_BUILD = ms('EVALS_TIMEOUT_BUILD', 60_000);

// --- Agent & verification ---

/** Default agent session timeout. Default: 600s */
export const TIMEOUT_SESSION = ms('EVALS_TIMEOUT_SESSION', 600_000);

/** Tree population agent session. Default: 900s (15 min) */
export const TIMEOUT_POPULATE = ms('EVALS_TIMEOUT_POPULATE', 900_000);

/** Verification script execution. Default: 120s */
export const TIMEOUT_VERIFY = ms('EVALS_TIMEOUT_VERIFY', 120_000);
