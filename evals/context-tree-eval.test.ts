/**
 * Context Tree eval test suite.
 *
 * Gated by EVALS=1 environment variable.
 * Run with: EVALS=1 pnpm run eval
 *
 * Conditions are configured via env vars:
 *   EVALS_CONDITIONS='baseline'                    — baseline only
 *   EVALS_CONDITIONS='baseline,cli-v0.0.3:aaa111'  — baseline + tree version
 *
 * Format: label or label:tree_sha (comma-separated)
 */

import { describe, test, afterAll } from 'vitest';
import type { AgentConfig, ContextTreeConfig } from '#evals/helpers/types.js';
import { loadCases } from '#evals/helpers/case-loader.js';
import { runTrial } from '#evals/helpers/condition-runner.js';
import { EvalCollector } from '#evals/helpers/eval-store.js';
import { resolveConditions } from '#evals/helpers/resolve-conditions.js';

const evalsEnabled = !!process.env.EVALS;
const trialCount = parseInt(process.env.EVALS_TRIALS || '1', 10);

const agent: AgentConfig = {
  cli: (process.env.EVALS_CLI as AgentConfig['cli']) || 'claude-code',
  model: process.env.EVALS_MODEL || 'claude-sonnet-4-6',
};

const treeConfig: ContextTreeConfig | undefined = process.env.EVALS_TREE_REPO
  ? { repo: process.env.EVALS_TREE_REPO }
  : undefined;

const caseFilter = process.env.EVALS_CASES
  ? process.env.EVALS_CASES.split(',').map(s => s.trim())
  : undefined;

const describeEval = evalsEnabled ? describe : describe.skip;

describeEval('context-tree eval', () => {
  const collector = new EvalCollector({ model: agent.model, cli: agent.cli });

  let cases: ReturnType<typeof loadCases>;
  try {
    cases = loadCases({ ids: caseFilter });
  } catch (err: any) {
    process.stderr.write(`⚠ ${err.message}\n`);
    cases = [];
  }

  afterAll(async () => {
    if (collector) {
      await collector.finalize();
    }
  });

  for (const evalCase of cases) {
    describe(evalCase.id, () => {
      const conditions = resolveConditions(evalCase);

      for (const condition of conditions) {
        for (let trial = 1; trial <= trialCount; trial++) {
          const testName = trialCount > 1
            ? `${condition.label} (trial ${trial})`
            : condition.label;

          test(testName, async () => {
            const result = await runTrial(evalCase, condition, trial, agent, treeConfig);
            collector.addTrial(result);
          }, evalCase.timeout_ms || 600_000);
        }
      }
    });
  }
});
