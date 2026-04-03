/**
 * Shared utilities for context tree management scripts.
 *
 * Provides branch naming, provenance formatting, preflight validation,
 * and git operations used by create-tree, update-tree, and list-trees.
 */

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TreeProvenance {
  codeRepo: string;
  codeCommit: string;
  cliCommit: string;
  cliVersion: string;
  model: string;
  timestamp: string;
}

export interface CreateTreeOptions {
  repo: string;        // e.g. "HKUDS/nanobot"
  commit: string;      // code repo commit SHA
  cliVersion: string;  // first-tree commit SHA
  treeRepo: string;    // e.g. "agent-team-foundation/eval-context-trees"
  model?: string;      // default: "claude-sonnet-4-6"
}

export interface UpdateTreeOptions extends CreateTreeOptions {}

export interface ListTreesOptions {
  treeRepo: string;
  repo?: string;       // filter to specific code repo
  commit?: string;     // filter to specific code commit
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIRST_TREE_REPO = 'https://github.com/agent-team-foundation/first-tree.git';

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Derive the tree repo branch name for a (code repo, commit) pair.
 * Matches the convention in repo-sandbox.ts.
 */
export function treeBranch(repo: string, commitSha: string): string {
  const repoName = repo.split('/').pop() || repo;
  return `${repoName}/${commitSha.slice(0, 8)}`;
}

/**
 * Format a structured commit message with provenance metadata.
 */
export function treeCommitMessage(provenance: TreeProvenance): string {
  return [
    `Generate tree with context-tree CLI @ ${provenance.cliCommit.slice(0, 7)}`,
    '',
    `repo: ${provenance.codeRepo}`,
    `code_commit: ${provenance.codeCommit}`,
    `cli_commit: ${provenance.cliCommit}`,
    `cli_version: ${provenance.cliVersion}`,
    `model: ${provenance.model}`,
    `timestamp: ${provenance.timestamp}`,
  ].join('\n');
}

/**
 * Parse CLI arguments from process.argv.
 * Supports --key value and --key=value formats.
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

function repoUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Preflight: verify repos exist and git auth works.
 * Throws on failure so expensive work is avoided.
 */
export function preflight(treeRepo: string, codeRepo: string, codeSha: string): void {
  process.stderr.write('Preflight checks...\n');

  // Check code repo is accessible
  try {
    execFileSync('git', ['ls-remote', '--exit-code', repoUrl(codeRepo), 'HEAD'], {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    throw new Error(`Code repo not accessible: ${codeRepo}`);
  }

  // Check tree repo is accessible (and writable — ls-remote succeeds if we have read access;
  // push access is only verified at push time, but at least we know the repo exists).
  // No --exit-code: empty repos have no refs but are still valid.
  try {
    execFileSync('git', ['ls-remote', repoUrl(treeRepo)], {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    throw new Error(`Tree repo not accessible: ${treeRepo}. Create it first with: gh repo create ${treeRepo} --private`);
  }

  process.stderr.write('  Repos accessible.\n');
}

/**
 * Clone the context tree repo. If branch is specified, clone that branch.
 * Returns the tmpdir path.
 */
export function cloneTreeRepo(treeRepo: string, branch?: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tree-repo-'));
  const url = repoUrl(treeRepo);

  if (branch) {
    try {
      execSync(
        `git clone --quiet --branch ${JSON.stringify(branch)} ${JSON.stringify(url)} ${JSON.stringify(tmp)}`,
        { stdio: 'pipe', timeout: 120_000 },
      );
      return tmp;
    } catch {
      // Branch may not exist yet — clone default and create orphan later
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tree-repo-'));
  execSync(
    `git clone --quiet ${JSON.stringify(url)} ${JSON.stringify(tmp2)}`,
    { stdio: 'pipe', timeout: 120_000 },
  );
  return tmp2;
}

/**
 * Clone code repo at a specific commit into a tmpdir. Returns the tmpdir path.
 */
export function cloneCodeRepo(codeRepo: string, commitSha: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-code-repo-'));
  const url = repoUrl(codeRepo);

  process.stderr.write(`Cloning ${codeRepo} @ ${commitSha.slice(0, 8)}...\n`);
  execSync(
    `git clone --quiet --no-checkout ${JSON.stringify(url)} ${JSON.stringify(tmp)}`,
    { stdio: 'pipe', timeout: 120_000 },
  );
  execSync(
    `git checkout --quiet ${commitSha}`,
    { cwd: tmp, stdio: 'pipe', timeout: 30_000 },
  );
  return tmp;
}

/**
 * Install the context-tree CLI from a specific first-tree commit.
 * Clones the first-tree repo at that commit, runs pnpm build && npm link
 * to make `context-tree` available globally.
 * Returns the path to the cloned first-tree directory.
 */
export function installCliAtVersion(cliCommit: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cli-'));

  process.stderr.write(`Installing context-tree CLI @ ${cliCommit.slice(0, 7)}...\n`);
  execSync(
    `git clone --quiet --no-checkout ${JSON.stringify(FIRST_TREE_REPO)} ${JSON.stringify(tmp)}`,
    { stdio: 'pipe', timeout: 120_000 },
  );
  execSync(
    `git checkout --quiet ${cliCommit}`,
    { cwd: tmp, stdio: 'pipe', timeout: 30_000 },
  );

  process.stderr.write('  Installing dependencies...\n');
  execSync('pnpm install --frozen-lockfile', {
    cwd: tmp,
    stdio: 'pipe',
    timeout: 120_000,
  });

  process.stderr.write('  Building and linking CLI...\n');
  execSync('pnpm build && npm link', {
    cwd: tmp,
    stdio: 'pipe',
    timeout: 60_000,
    shell: '/bin/bash',
  });

  // Read CLI version from package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8'));
  process.stderr.write(`  Installed context-tree v${pkg.version} (globally linked)\n`);

  return tmp;
}

/**
 * Read the CLI version from the built first-tree package.json.
 */
export function getCliVersion(cliDir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf-8'));
  return pkg.version || 'unknown';
}

/**
 * Prepare a tree repo directory so `context-tree init` can run in it.
 * After createOrphanBranch, the dir is a git repo but may have no commits.
 * We create an initial empty commit so git operations work normally.
 */
export function initBareTreeDir(treeDir: string): void {
  execSync('git commit --allow-empty -m "init"', {
    cwd: treeDir,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'context-tree-eval', GIT_AUTHOR_EMAIL: 'eval@context-tree', GIT_COMMITTER_NAME: 'context-tree-eval', GIT_COMMITTER_EMAIL: 'eval@context-tree' },
  });
}

/**
 * Commit all files in the tree repo directory with provenance metadata.
 * Returns the new commit SHA.
 */
export function commitTree(treeDir: string, provenance: TreeProvenance): string {
  const message = treeCommitMessage(provenance);

  execSync('git add -A', { cwd: treeDir, stdio: 'pipe' });

  // Check if there are changes to commit
  const status = execSync('git status --porcelain', { cwd: treeDir, encoding: 'utf-8' }).trim();
  if (!status) {
    throw new Error('No changes to commit — tree content is identical to previous version');
  }

  execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd: treeDir,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'context-tree-eval', GIT_AUTHOR_EMAIL: 'eval@context-tree', GIT_COMMITTER_NAME: 'context-tree-eval', GIT_COMMITTER_EMAIL: 'eval@context-tree' },
  });

  const sha = execSync('git rev-parse HEAD', { cwd: treeDir, encoding: 'utf-8' }).trim();
  return sha;
}

/**
 * Create an orphan branch in the tree repo directory.
 */
export function createOrphanBranch(treeDir: string, branch: string): void {
  execSync(`git checkout --orphan ${JSON.stringify(branch)}`, {
    cwd: treeDir,
    stdio: 'pipe',
  });
  // Remove all tracked files from index (orphan branch starts with files staged).
  // Tolerate empty repos where there is nothing to remove.
  try {
    execSync('git rm -rf --quiet .', { cwd: treeDir, stdio: 'pipe' });
  } catch { /* empty repo — nothing to remove */ }
}

/**
 * Push a branch to origin.
 */
export function pushBranch(treeDir: string, branch: string): void {
  process.stderr.write(`Pushing to origin/${branch}...\n`);
  execSync(`git push origin ${JSON.stringify(branch)}`, {
    cwd: treeDir,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/**
 * Check whether a remote branch exists.
 */
export function remoteBranchExists(treeRepo: string, branch: string): boolean {
  try {
    const output = execFileSync(
      'git',
      ['ls-remote', '--heads', repoUrl(treeRepo), branch],
      { stdio: 'pipe', timeout: 30_000, encoding: 'utf-8' },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * List all remote branches in the tree repo.
 * Returns array of branch names (without refs/heads/ prefix).
 */
export function listRemoteBranches(treeRepo: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-remote', '--heads', repoUrl(treeRepo)],
    { stdio: 'pipe', timeout: 30_000, encoding: 'utf-8' },
  );

  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const ref = line.split('\t')[1] || '';
      return ref.replace('refs/heads/', '');
    })
    .filter(Boolean);
}

/**
 * Get commit log for a specific branch in the tree repo.
 * Returns array of { sha, message } objects.
 */
export function listBranchCommits(
  treeRepo: string,
  branch: string,
): Array<{ sha: string; message: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-list-'));
  try {
    execSync(
      `git clone --quiet --branch ${JSON.stringify(branch)} --single-branch ${JSON.stringify(repoUrl(treeRepo))} ${JSON.stringify(tmp)}`,
      { stdio: 'pipe', timeout: 120_000 },
    );

    const output = execSync('git log --format=%H%x00%s', {
      cwd: tmp,
      encoding: 'utf-8',
      timeout: 10_000,
    });

    return output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [sha, ...rest] = line.split('\0');
        return { sha, message: rest.join('\0') };
      });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
