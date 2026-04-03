/**
 * List available context trees and their versions in the tree repo.
 *
 * Usage:
 *   npx tsx evals/scripts/list-trees.ts --tree-repo agent-team-foundation/eval-context-trees
 *   npx tsx evals/scripts/list-trees.ts --tree-repo <repo> --repo HKUDS/nanobot --commit ddc9fc4f
 *
 * Environment:
 *   EVALS_TREE_REPO — default tree repo slug
 */

import {
  parseArgs,
  listRemoteBranches,
  listBranchCommits,
  treeBranch,
} from './tree-manager.js';

export interface ListResult {
  branches: Array<{
    branch: string;
    commits?: Array<{ sha: string; message: string }>;
  }>;
}

export async function listTrees(options: {
  treeRepo: string;
  repo?: string;
  commit?: string;
}): Promise<ListResult> {
  const { treeRepo, repo, commit } = options;

  const branches = listRemoteBranches(treeRepo);

  if (repo && commit) {
    // Show versions for a specific tree
    const branch = treeBranch(repo, commit);
    if (!branches.includes(branch)) {
      process.stderr.write(`Branch ${branch} not found in ${treeRepo}\n`);
      return { branches: [] };
    }

    const commits = listBranchCommits(treeRepo, branch);
    return { branches: [{ branch, commits }] };
  }

  // List all branches
  return {
    branches: branches.map(b => ({ branch: b })),
  };
}

function printResult(result: ListResult): void {
  if (result.branches.length === 0) {
    console.log('No trees found.');
    return;
  }

  for (const { branch, commits } of result.branches) {
    console.log(`\n  ${branch}`);
    if (commits) {
      console.log('  ' + '─'.repeat(60));
      for (const c of commits) {
        console.log(`    ${c.sha.slice(0, 10)}  ${c.message}`);
      }
    }
  }
  console.log('');
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/list-trees.ts')) {
  const args = parseArgs(process.argv.slice(2));
  const treeRepo = args['tree-repo'] || process.env.EVALS_TREE_REPO;

  if (!treeRepo) {
    console.error('Usage: list-trees --tree-repo <repo> [--repo <code-repo> --commit <sha>]');
    console.error('  Or set EVALS_TREE_REPO environment variable.');
    process.exit(1);
  }

  listTrees({ treeRepo, repo: args.repo, commit: args.commit })
    .then(printResult)
    .catch(err => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
