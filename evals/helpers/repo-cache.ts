/**
 * Git repo cache — avoids redundant network clones across eval trials.
 *
 * Maintains full clones in a cache directory. When a sandbox is needed:
 * 1. Ensure the repo is cached (clone on miss, fetch on hit)
 * 2. cp -a the cache into the target directory
 * 3. Checkout the desired commit and clean to pristine state
 *
 * Each sandbox is fully independent — patches from eval tasks are
 * confined to the sandbox and destroyed on cleanup.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv, getEnv } from '#evals/helpers/env.js';
import {
  TIMEOUT_GIT_CLONE,
  TIMEOUT_GIT_FETCH,
  TIMEOUT_GIT_CHECKOUT,
  TIMEOUT_GIT_CLEAN,
  TIMEOUT_GIT_RESET,
  TIMEOUT_COPY,
} from '#evals/helpers/timeouts.js';

loadEnv();

/** Return the cache root directory, creating it if needed. */
export function getRepoCacheDir(): string {
  const dir = getEnv('EVALS_REPO_CACHE', '~/.context-tree/repo-cache')!;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Convert a repo slug to a cache-safe directory name. */
function cacheKey(repoSlug: string): string {
  return repoSlug.replace(/\//g, '--');
}

function repoUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Ensure a repo is present in the cache. Clones on first use, fetches on subsequent.
 * Returns the absolute path to the cached repo directory.
 */
export function ensureCached(repoSlug: string): string {
  const cacheDir = getRepoCacheDir();
  const repoDir = path.join(cacheDir, cacheKey(repoSlug));

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    // Cache hit — fetch latest refs
    process.stderr.write(`  Cache hit: ${repoSlug} — fetching updates...\n`);
    try {
      execSync('git fetch origin', {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: TIMEOUT_GIT_FETCH,
      });
    } catch (err: any) {
      process.stderr.write(`  Warning: fetch failed for cached ${repoSlug}: ${err.message}\n`);
    }
  } else {
    // Cache miss — full clone
    process.stderr.write(`  Cache miss: ${repoSlug} — cloning into cache...\n`);
    const url = repoUrl(repoSlug);
    execSync(
      `git clone --quiet --no-checkout ${JSON.stringify(url)} ${JSON.stringify(repoDir)}`,
      { stdio: 'pipe', timeout: TIMEOUT_GIT_CLONE },
    );
  }

  return repoDir;
}

export interface CloneFromCacheOptions {
  branch?: string;
  commitSha?: string;
  noCheckout?: boolean;
}

/**
 * Create a sandbox directory from the cache.
 *
 * Copies the cached repo into targetDir, then checks out the desired
 * commit/branch and cleans to a pristine state.
 */
export function cloneFromCache(
  repoSlug: string,
  targetDir: string,
  opts?: CloneFromCacheOptions,
): void {
  const cachedDir = ensureCached(repoSlug);

  process.stderr.write(`  Copying ${repoSlug} from cache...\n`);
  execSync(
    `cp -a ${JSON.stringify(cachedDir + '/')}. ${JSON.stringify(targetDir)}`,
    { stdio: 'pipe', timeout: TIMEOUT_COPY },
  );

  if (opts?.noCheckout) return;

  if (opts?.branch) {
    execSync(
      `git checkout --quiet ${JSON.stringify(opts.branch)}`,
      { cwd: targetDir, stdio: 'pipe', timeout: TIMEOUT_GIT_CHECKOUT },
    );
  }

  if (opts?.commitSha) {
    execSync(
      `git checkout --quiet ${opts.commitSha}`,
      { cwd: targetDir, stdio: 'pipe', timeout: TIMEOUT_GIT_CHECKOUT },
    );
  }

  // Ensure pristine working tree — remove any stale files
  execSync('git clean -fdx', {
    cwd: targetDir,
    stdio: 'pipe',
    timeout: TIMEOUT_GIT_CLEAN,
  });
  execSync('git reset --hard', {
    cwd: targetDir,
    stdio: 'pipe',
    timeout: TIMEOUT_GIT_RESET,
  });
}
