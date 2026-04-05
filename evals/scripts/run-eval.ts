#!/usr/bin/env npx tsx
/**
 * End-to-end eval runner.
 *
 * Orchestrates the full pipeline:
 *   1. Check runtime environments (verify.sh fails before fix, passes after)
 *   2. Create context trees for cases that don't have them
 *   3. Run evals (baseline + tree conditions, N trials)
 *   4. Generate aggregate HTML report
 *
 * Usage:
 *   npx tsx evals/scripts/run-eval.ts
 *   npx tsx evals/scripts/run-eval.ts --cases nanobot-exectool-regex --trials 3
 *   npx tsx evals/scripts/run-eval.ts --skip-check --skip-trees
 */

import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadCases } from '#evals/helpers/case-loader.js';
import { getEnv } from '#evals/helpers/env.js';
import type { EvalCase } from '#evals/helpers/types.js';
import { remoteBranchExists, treeBranch } from '#evals/scripts/tree-manager.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
    trials: { type: 'string', default: '1' },
    model: { type: 'string' },
    'tree-repo': { type: 'string' },
    'skip-check': { type: 'boolean', default: false },
    'skip-trees': { type: 'boolean', default: false },
  },
  strict: false,
});

const caseIds = values.cases ? (values.cases as string).split(',').map(s => s.trim()) : undefined;
const trials = values.trials as string;
const model = (values.model as string) || getEnv('EVALS_MODEL', 'claude-sonnet-4-6')!;
const treeRepo = (values['tree-repo'] as string) || getEnv('EVALS_TREE_REPO') || '';
const skipCheck = values['skip-check'] as boolean;
const skipTrees = values['skip-trees'] as boolean;

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const cases = loadCases({ ids: caseIds });

console.log(`\nEval Runner — ${cases.length} case(s), ${trials} trial(s), model: ${model}`);
if (treeRepo) console.log(`Tree repo: ${treeRepo}`);
console.log();

// ---------------------------------------------------------------------------
// Step 1: Check environments
// ---------------------------------------------------------------------------

if (!skipCheck) {
  console.log('═══ Step 1: Checking runtime environments ═══\n');

  const checkArgs = caseIds ? `--cases ${caseIds.join(',')}` : '';
  const checkResult = spawnSync(
    'npx', ['tsx', 'evals/scripts/check-env.ts', ...checkArgs.split(' ').filter(Boolean)],
    { cwd: REPO_ROOT, stdio: 'inherit', timeout: 1_800_000 }, // 30 min for all cases
  );

  if (checkResult.status !== 0) {
    console.error('\nEnvironment check failed. Fix the issues above before running evals.');
    process.exit(1);
  }
  console.log();
} else {
  console.log('═══ Step 1: Skipped (--skip-check) ═══\n');
}

// ---------------------------------------------------------------------------
// Step 2: Create context trees
// ---------------------------------------------------------------------------

if (!skipTrees && treeRepo) {
  console.log('═══ Step 2: Ensuring context trees exist ═══\n');

  const cliVersion = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();

  for (const evalCase of cases) {
    const ref = evalCase.repos[0];
    const branch = treeBranch(ref.repo, ref.commit_sha);

    if (remoteBranchExists(treeRepo, branch)) {
      console.log(`  ✓ ${evalCase.id} ��� tree exists (${branch})`);
      continue;
    }

    console.log(`  ○ ${evalCase.id} — creating tree...`);
    const createResult = spawnSync(
      'npx',
      ['tsx', 'evals/scripts/create-tree.ts',
        '--repo', ref.repo,
        '--commit', ref.commit_sha,
        '--cli-version', cliVersion,
        '--tree-repo', treeRepo,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit', timeout: 1_200_000 }, // 20 min
    );

    if (createResult.status !== 0) {
      console.error(`  ✗ ${evalCase.id} — tree creation failed (non-fatal, continuing)`);
    }
  }
  console.log();
} else if (skipTrees) {
  console.log('═══ Step 2: Skipped (--skip-trees) ═══\n');
} else {
  console.log('═══ Step 2: Skipped (no --tree-repo) ═══\n');
}

// ---------------------------------------------------------------------------
// Step 3: Run evals
// ---------------------------------------------------------------------------

console.log('═══ Step 3: Running evals ═══\n');

const evalEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  EVALS: '1',
  EVALS_TRIALS: trials,
  EVALS_MODEL: model,
};
if (caseIds) evalEnv.EVALS_CASES = caseIds.join(',');
if (treeRepo) evalEnv.EVALS_TREE_REPO = treeRepo;

const evalResult = spawnSync(
  'pnpm', ['run', 'eval'],
  { cwd: REPO_ROOT, stdio: 'inherit', env: evalEnv, timeout: 7_200_000 }, // 2 hours
);

if (evalResult.status !== 0) {
  console.error('\nEval run had failures (see above). Continuing to report generation.\n');
}

// ---------------------------------------------------------------------------
// Step 4: Generate report
// ---------------------------------------------------------------------------

console.log('\n═══ Step 4: Generating aggregate report ═══\n');

const evalDir = getEnv('EVALS_STORE_DIR', '~/.first-tree/evals')!;
if (!fs.existsSync(evalDir)) {
  console.error(`No eval results found in ${evalDir}`);
  process.exit(1);
}

// Find all JSON files from today's runs
const today = new Date().toISOString().slice(0, 10);
const jsonFiles = fs.readdirSync(evalDir)
  .filter(f => f.endsWith('.json') && f.includes(today))
  .map(f => path.join(evalDir, f))
  .sort();

if (jsonFiles.length === 0) {
  console.error(`No eval results from today (${today}) found in ${evalDir}`);
  process.exit(1);
}

console.log(`Found ${jsonFiles.length} result file(s) from ${today}`);

const reportResult = spawnSync(
  'npx', ['tsx', 'evals/scripts/aggregate-report.ts', ...jsonFiles],
  { cwd: REPO_ROOT, stdio: 'inherit', timeout: 30_000 },
);

if (reportResult.status !== 0) {
  console.error('Report generation failed.');
  process.exit(1);
}

console.log('\nDone.');
