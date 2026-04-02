/**
 * Create a new context tree for a code repo at a specific commit.
 *
 * Workflow:
 * 1. Clone code repo at commit (read-only reference)
 * 2. Install context-tree CLI globally (pnpm build && npm link)
 * 3. Clone tree repo, create orphan branch, init as git repo
 * 4. Spawn Claude Code IN the tree repo with a prompt that points
 *    to the source code path — agent runs context-tree init and
 *    populates the full tree
 * 5. Commit and push
 *
 * Usage:
 *   npx tsx evals/scripts/create-tree.ts \
 *     --repo HKUDS/nanobot \
 *     --commit ddc9fc4f \
 *     --cli-version abc123 \
 *     --tree-repo agent-team-foundation/nanobot-eval-tree
 *
 * Authentication: relies on ambient git credentials (gh auth / GH_TOKEN).
 */

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import {
  parseArgs,
  preflight,
  cloneCodeRepo,
  installCliAtVersion,
  getCliVersion,
  cloneTreeRepo,
  createOrphanBranch,
  commitTree,
  pushBranch,
  treeBranch,
  remoteBranchExists,
  initBareTreeDir,
  type CreateTreeOptions,
  type TreeProvenance,
} from './tree-manager.js';
import { runSession } from '#evals/helpers/session-runner.js';
import type { AgentConfig } from '#evals/helpers/types.js';

function buildPrompt(codeDir: string): string {
  return `You are initializing and populating a context tree for a codebase.

## Source code location
The source code repository is cloned at: ${codeDir}
Read the source code from that path to understand the project structure. Do NOT modify anything in that directory.

## Your working directory
You are working in a context tree repository. This is where the context tree will live. \`context-tree\` is a CLI tool that is already installed and available on your PATH.

## Step 1: Learn about context trees
Run \`context-tree help onboarding\` to understand what a context tree is, how it is structured, and the full setup workflow.

## Step 2: Initialize
Run \`context-tree init\` in this directory. This bootstraps the framework, creates template files, and generates a task list in .context-tree/progress.md.

## Step 3: Complete the task list
Read .context-tree/progress.md and complete every task. Check off each task as you finish it by changing \`- [ ]\` to \`- [x]\`.

## Step 4: Populate the full tree
When the task list asks whether to populate the tree, choose **Yes**. Then:
- Analyze the source code at ${codeDir} thoroughly to identify all logical domains and sub-domains.
- For each domain and sub-domain, create a directory with a NODE.md containing:
  - Valid frontmatter (title, owners)
  - Description of the domain's purpose, boundaries, and key decisions
  - Cross-domain relationships via soft_links in frontmatter
- Go deep: create sub-domains within domains when the domain is large enough. Do not stop at top-level domains only.
- Use TaskCreate to parallelize work across top-level domains.
- After all domains are populated, update the root NODE.md to list every top-level domain.

## Rules
- Do not ask the user any questions — make reasonable decisions autonomously.
- When the progress file asks you to use AskUserQuestion, skip that step and make a reasonable choice yourself.
- Run \`context-tree verify\` when done to confirm the tree is valid.
- Ensure every directory that has content gets a NODE.md.
- All file writes go in THIS directory (the tree repo), never in the source code directory.
`;
}

const POPULATE_MAX_TURNS = 80;
const POPULATE_TIMEOUT = 900_000; // 15 minutes

export async function createTree(options: CreateTreeOptions): Promise<{ branch: string; sha: string }> {
  const { repo, commit, cliVersion, treeRepo, model = 'claude-sonnet-4-6' } = options;
  const branch = treeBranch(repo, commit);

  // Preflight
  preflight(treeRepo, repo, commit);

  if (remoteBranchExists(treeRepo, branch)) {
    throw new Error(
      `Branch ${branch} already exists in ${treeRepo}. Use update-tree to add a new version.`,
    );
  }

  const tmpdirs: string[] = [];
  const cleanup = () => {
    for (const d of tmpdirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  try {
    // 1. Clone code repo at commit (read-only reference)
    const codeDir = cloneCodeRepo(repo, commit);
    tmpdirs.push(codeDir);

    // 2. Install context-tree CLI globally via npm link
    const cliDir = installCliAtVersion(cliVersion);
    tmpdirs.push(cliDir);
    const cliVer = getCliVersion(cliDir);

    // 3. Clone tree repo, create orphan branch, init as git repo
    const treeDir = cloneTreeRepo(treeRepo);
    tmpdirs.push(treeDir);
    createOrphanBranch(treeDir, branch);
    initBareTreeDir(treeDir);

    // 4. Spawn Claude Code in the tree repo directory
    process.stderr.write('Spawning agent to init and populate context tree...\n');
    const agent: AgentConfig = { cli: 'claude-code', model };
    const session = await runSession({
      prompt: buildPrompt(codeDir),
      workingDirectory: treeDir,
      agent,
      maxTurns: POPULATE_MAX_TURNS,
      timeout: POPULATE_TIMEOUT,
      testName: `create-tree/${repo}`,
    });

    const exitOk = session.exitReason === 'success';
    process.stderr.write(
      `  Agent finished: ${session.exitReason}, ${session.costEstimate.turnsUsed} turns, $${session.costEstimate.estimatedCost.toFixed(2)}\n`,
    );
    if (!exitOk) {
      process.stderr.write('  Warning: agent did not exit cleanly. Committing partial tree.\n');
    }

    // 5. Commit with provenance and push
    const provenance: TreeProvenance = {
      codeRepo: repo,
      codeCommit: commit,
      cliCommit: cliVersion,
      cliVersion: cliVer,
      model,
      timestamp: new Date().toISOString(),
    };

    const sha = commitTree(treeDir, provenance);
    pushBranch(treeDir, branch);

    process.stderr.write(`\nDone! Tree created:\n`);
    process.stderr.write(`  Branch: ${branch}\n`);
    process.stderr.write(`  Commit: ${sha}\n`);
    process.stderr.write(`  CLI:    context-tree v${cliVer} (${cliVersion.slice(0, 7)})\n`);

    return { branch, sha };
  } finally {
    cleanup();
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/create-tree.ts')) {
  const args = parseArgs(process.argv.slice(2));
  const treeRepo = args['tree-repo'] || process.env.EVALS_TREE_REPO;

  if (!args.repo || !args.commit || !args['cli-version'] || !treeRepo) {
    console.error('Usage: create-tree --repo <org/repo> --commit <sha> --cli-version <sha> --tree-repo <repo>');
    console.error('  --repo          Code repository (e.g. HKUDS/nanobot)');
    console.error('  --commit        Code repo commit SHA');
    console.error('  --cli-version   first-tree commit SHA for CLI version');
    console.error('  --tree-repo     Tree repo slug (or set EVALS_TREE_REPO)');
    console.error('  --model         Agent model (default: claude-sonnet-4-6)');
    process.exit(1);
  }

  createTree({
    repo: args.repo,
    commit: args.commit,
    cliVersion: args['cli-version'],
    treeRepo,
    model: args.model,
  })
    .then(({ branch, sha }) => {
      console.log(JSON.stringify({ branch, sha }));
    })
    .catch(err => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
