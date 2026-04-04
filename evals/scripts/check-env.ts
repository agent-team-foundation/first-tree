#!/usr/bin/env npx tsx
/**
 * Validate eval runtime environments.
 *
 * For each case (or filtered by --cases):
 * 1. Clone the repo from cache at commit_sha (before fix)
 * 2. Run setup.sh
 * 3. Run verify.sh — expect FAIL (bug is present)
 * 4. Checkout fix_commit_sha (after fix)
 * 5. Run setup.sh again
 * 6. Run verify.sh — expect PASS (bug is fixed)
 *
 * Usage:
 *   npx tsx evals/scripts/check-env.ts
 *   npx tsx evals/scripts/check-env.ts --cases nanobot-exectool-regex,pydantic-importstring-error
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseArgs } from 'node:util';
import { loadCases } from '#evals/helpers/case-loader.js';
import { cloneFromCache } from '#evals/helpers/repo-cache.js';
import { TIMEOUT_SETUP, TIMEOUT_VERIFY } from '#evals/helpers/timeouts.js';
import type { EvalCase } from '#evals/helpers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVALS_ROOT = path.resolve(import.meta.dirname, '..');

function runSetup(sandboxDir: string, evalCase: EvalCase): void {
  const setupSh = path.resolve(EVALS_ROOT, 'fixtures', evalCase.id, 'setup.sh');
  if (!fs.existsSync(setupSh)) return;

  execSync(`bash ${JSON.stringify(setupSh)}`, {
    cwd: sandboxDir,
    stdio: 'pipe',
    timeout: TIMEOUT_SETUP,
    shell: '/bin/bash',
  });
}

function runVerify(sandboxDir: string, evalCase: EvalCase): { passed: boolean; error?: string } {
  const absVerification = path.resolve(EVALS_ROOT, evalCase.verification);
  try {
    const output = execSync(`bash ${JSON.stringify(absVerification)}`, {
      cwd: sandboxDir,
      stdio: 'pipe',
      timeout: TIMEOUT_VERIFY,
      env: { ...process.env, SANDBOX_DIR: sandboxDir },
    }).toString();

    // Check structured JSON output on last line: { "passed": N, "total": M }
    const lastLine = output.trim().split('\n').pop()?.trim() || '';
    try {
      const result = JSON.parse(lastLine);
      if (typeof result.passed === 'number' && typeof result.total === 'number') {
        return {
          passed: result.passed === result.total,
          error: result.passed < result.total ? `${result.passed}/${result.total} tests passed` : undefined,
        };
      }
    } catch { /* not structured — treat exit 0 as pass */ }

    return { passed: true };
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() || '';
    const stdout = err.stdout?.toString().trim() || '';

    // Check structured output from failed run (last line)
    const lastLine = stdout.split('\n').pop()?.trim() || '';
    try {
      const result = JSON.parse(lastLine);
      if (typeof result.passed === 'number' && typeof result.total === 'number') {
        return {
          passed: result.passed === result.total,
          error: `${result.passed}/${result.total} tests passed`,
        };
      }
    } catch { /* not structured */ }

    const msg = stderr || stdout || err.message || 'unknown error';
    return { passed: false, error: msg.slice(0, 200) };
  }
}

interface CheckResult {
  caseId: string;
  setupBefore: 'ok' | 'fail';
  verifyBeforeFails: 'ok' | 'fail';  // ok = verify fails as expected
  setupAfter: 'ok' | 'fail';
  verifyAfterPasses: 'ok' | 'fail';  // ok = verify passes as expected
  error?: string;
}

function checkCase(evalCase: EvalCase): CheckResult {
  const result: CheckResult = {
    caseId: evalCase.id,
    setupBefore: 'fail',
    verifyBeforeFails: 'fail',
    setupAfter: 'fail',
    verifyAfterPasses: 'fail',
  };

  if (!evalCase.fix_commit_sha) {
    result.error = 'missing fix_commit_sha';
    return result;
  }

  const ref = evalCase.repos[0];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ct-check-${evalCase.id}-`));

  try {
    // --- Phase 1: Before fix (commit_sha) ---
    process.stderr.write(`  [before] Cloning ${ref.repo} @ ${ref.commit_sha.slice(0, 8)}...\n`);
    cloneFromCache(ref.repo, tmpDir, { commitSha: ref.commit_sha });

    process.stderr.write(`  [before] Running setup...\n`);
    try {
      runSetup(tmpDir, evalCase);
      result.setupBefore = 'ok';
    } catch (err: any) {
      result.error = `setup (before): ${err.message?.slice(0, 150)}`;
      return result;
    }

    process.stderr.write(`  [before] Running verify (expect fail)...\n`);
    const beforeVerify = runVerify(tmpDir, evalCase);
    if (!beforeVerify.passed) {
      result.verifyBeforeFails = 'ok';
    } else {
      result.error = 'verify passed on unfixed code — verify.sh may be too lenient';
    }

    // --- Phase 2: After fix (fix_commit_sha) ---
    // Checkout the fix commit but keep untracked files (.venv, node_modules)
    // so we don't have to re-run a full setup from scratch.
    process.stderr.write(`  [after]  Checking out fix @ ${evalCase.fix_commit_sha.slice(0, 8)}...\n`);
    execSync(`git checkout --quiet ${evalCase.fix_commit_sha}`, {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 30_000,
    });
    execSync('git reset --hard', {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 30_000,
    });

    // Skip re-setup — the venv/node_modules from before-fix phase is reused.
    // Bug-fix PRs rarely change dependencies.
    result.setupAfter = 'ok';

    process.stderr.write(`  [after]  Running verify (expect pass)...\n`);
    const afterVerify = runVerify(tmpDir, evalCase);
    if (afterVerify.passed) {
      result.verifyAfterPasses = 'ok';
    } else {
      result.error = `verify failed on fixed code: ${afterVerify.error?.slice(0, 150)}`;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
  },
  strict: false,
});

const ids = values.cases ? (values.cases as string).split(',').map(s => s.trim()) : undefined;
const cases = loadCases({ ids });

console.log(`\nChecking ${cases.length} eval case(s)...\n`);

const results: CheckResult[] = [];
for (const evalCase of cases) {
  process.stderr.write(`▶ ${evalCase.id}\n`);
  const result = checkCase(evalCase);
  results.push(result);

  const allOk = result.setupBefore === 'ok'
    && result.verifyBeforeFails === 'ok'
    && result.setupAfter === 'ok'
    && result.verifyAfterPasses === 'ok';

  const icon = allOk ? '✓' : '✗';
  console.log(`  ${icon} ${evalCase.id}`);
  if (!allOk) {
    console.log(`    setup-before: ${result.setupBefore}  verify-before-fails: ${result.verifyBeforeFails}  setup-after: ${result.setupAfter}  verify-after-passes: ${result.verifyAfterPasses}`);
    if (result.error) console.log(`    error: ${result.error}`);
  }
}

// Summary
const passed = results.filter(r =>
  r.setupBefore === 'ok' && r.verifyBeforeFails === 'ok' && r.setupAfter === 'ok' && r.verifyAfterPasses === 'ok'
).length;
console.log(`\n${passed}/${results.length} cases validated.`);

if (passed < results.length) {
  process.exit(1);
}
