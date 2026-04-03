/**
 * Repo sandbox: create isolated working directories for eval trials.
 *
 * Clones one or more repos into a tmpdir at specific commits.
 * If the condition specifies a context tree (tree_sha), clones the
 * tree repo and overlays it into the sandbox.
 *
 * Single-repo layout:   /tmp/ct-eval-xxx/  (repo cloned at root)
 * Multi-repo layout:    /tmp/ct-eval-xxx/backend/
 *                       /tmp/ct-eval-xxx/web/
 *                       /tmp/ct-eval-xxx/mobile/
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EvalCase, EvalCondition, ContextTreeConfig, RepoRef } from '#evals/helpers/types.js';

export interface Sandbox {
  dir: string;
  cleanup: () => void;
}

function cloneRepo(ref: RepoRef, targetDir: string): void {
  const isLocal = !ref.repo.includes('/') || fs.existsSync(ref.repo);
  const cloneUrl = isLocal ? ref.repo : `https://github.com/${ref.repo}.git`;

  process.stderr.write(`  Cloning ${ref.repo} @ ${ref.commit_sha.slice(0, 8)}...\n`);
  execSync(
    `git clone --quiet --no-checkout --filter=blob:none ${JSON.stringify(cloneUrl)} ${JSON.stringify(targetDir)}`,
    { stdio: 'pipe', timeout: 300_000 },
  );
  execSync(
    `git checkout --quiet ${ref.commit_sha}`,
    { cwd: targetDir, stdio: 'pipe', timeout: 120_000 },
  );

  if (ref.setup) {
    process.stderr.write(`  Running setup for ${ref.repo}...\n`);
    execSync(ref.setup, {
      cwd: targetDir,
      stdio: 'pipe',
      timeout: 300_000,
      shell: '/bin/bash',
    });
  }
}

/** Derive the default subdirectory name from a repo slug. */
function defaultPath(repo: string): string {
  return repo.split('/').pop() || repo;
}

export async function createSandbox(
  evalCase: EvalCase,
  condition: EvalCondition,
  treeConfig?: ContextTreeConfig,
): Promise<Sandbox> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ct-eval-${evalCase.id}-`));
  const isMultiRepo = evalCase.repos.length > 1;

  try {
    if (isMultiRepo) {
      // Multi-repo: each repo gets its own subdirectory
      for (const ref of evalCase.repos) {
        const subdir = ref.path || defaultPath(ref.repo);
        const targetDir = path.join(tmpDir, subdir);
        cloneRepo(ref, targetDir);
      }
    } else {
      // Single-repo: clone directly into tmpDir
      const ref = evalCase.repos[0];
      cloneRepo(ref, tmpDir);
    }

    // Inject context tree if the condition specifies one
    if (condition.tree_sha && treeConfig) {
      const treeUrl = `https://github.com/${treeConfig.repo}.git`;
      const treeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-eval-tree-'));

      try {
        // Derive branch name from primary repo
        const primaryRepo = evalCase.repos[0];
        const repoName = defaultPath(primaryRepo.repo);
        const branch = `${repoName}/${primaryRepo.commit_sha.slice(0, 8)}`;

        process.stderr.write(`  Cloning context tree @ ${condition.tree_sha.slice(0, 8)} (${condition.label})...\n`);
        execSync(
          `git clone --quiet --branch ${JSON.stringify(branch)} ${JSON.stringify(treeUrl)} ${JSON.stringify(treeTmp)}`,
          { stdio: 'pipe', timeout: 60_000 },
        );
        execSync(
          `git checkout --quiet ${condition.tree_sha}`,
          { cwd: treeTmp, stdio: 'pipe', timeout: 10_000 },
        );

        // Overlay tree files into sandbox root (skip .git)
        const entries = fs.readdirSync(treeTmp);
        for (const entry of entries) {
          if (entry === '.git') continue;
          const src = path.join(treeTmp, entry);
          const dest = path.join(tmpDir, entry);
          execSync(`cp -a ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: 'ignore' });
        }
        process.stderr.write(`  Injected context tree (${condition.label}).\n`);
      } finally {
        try { fs.rmSync(treeTmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  return {
    dir: tmpDir,
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
