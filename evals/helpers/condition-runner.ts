/**
 * Condition runner: orchestrates a single eval trial.
 *
 * For a given (case, condition, trial), it:
 * 1. Creates a sandbox (cloned repo at the target commit)
 * 2. Constructs the appropriate prompt per condition
 * 3. Runs the agent session
 * 4. Executes verification tests
 * 5. Returns a TrialResult
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { EvalCase, EvalCondition, AgentConfig, TrialResult, ContextTreeConfig } from './types.js';
import { createSandbox } from './repo-sandbox.js';
import { runSession } from './session-runner.js';

// --- Prompt construction ---

function buildPrompt(evalCase: EvalCase, condition: EvalCondition): string {
  const parts: string[] = [];

  // Base task
  parts.push(`You are working in a code repository. Your task:\n\n${evalCase.task}`);

  // If the condition has a tree, tell the agent about it
  if (condition.tree_sha) {
    parts.push(
      '\n\n## Context Tree',
      'This repository contains a context tree — a structured knowledge base in NODE.md files.',
      'Before starting, read the root NODE.md to understand the project structure and domains.',
      'Follow soft_links in frontmatter to discover related context.',
      'Use the context tree to understand architecture, conventions, and cross-domain relationships.',
    );
  }

  parts.push(
    '\n\n## Instructions',
    'Make the minimal changes needed to complete the task.',
    'Do not refactor unrelated code or add unnecessary features.',
  );

  return parts.join('\n');
}

// --- Verification ---

interface VerificationResult {
  passed: boolean;
  tests_total: number;
  tests_passed: number;
  error?: string;
}

function runVerification(
  sandboxDir: string,
  verificationPath: string,
  evalsRoot: string,
): VerificationResult {
  const absVerification = path.resolve(evalsRoot, verificationPath);

  try {
    const output = execSync(`bash ${JSON.stringify(absVerification)}`, {
      cwd: sandboxDir,
      stdio: 'pipe',
      timeout: 120_000,
      env: { ...process.env, SANDBOX_DIR: sandboxDir },
    }).toString();

    // Try to parse structured output: { "passed": N, "total": M }
    try {
      const result = JSON.parse(output.trim());
      if (typeof result.passed === 'number' && typeof result.total === 'number') {
        return {
          passed: result.passed === result.total,
          tests_total: result.total,
          tests_passed: result.passed,
        };
      }
    } catch { /* not structured — treat as pass */ }

    return { passed: true, tests_total: 1, tests_passed: 1 };
  } catch (err: any) {
    // Try to parse structured output from failed run
    const output = err.stdout?.toString() || '';
    try {
      const result = JSON.parse(output.trim());
      if (typeof result.passed === 'number' && typeof result.total === 'number') {
        return {
          passed: false,
          tests_total: result.total,
          tests_passed: result.passed,
          error: err.message,
        };
      }
    } catch { /* not structured */ }

    return {
      passed: false,
      tests_total: 1,
      tests_passed: 0,
      error: err.message?.slice(0, 500),
    };
  }
}

// --- Main trial runner ---

export async function runTrial(
  evalCase: EvalCase,
  condition: EvalCondition,
  trial: number,
  agent: AgentConfig,
  treeConfig?: ContextTreeConfig,
): Promise<TrialResult> {
  const evalsRoot = path.resolve(import.meta.dirname, '..');
  const testName = `${evalCase.id}/${condition.label}/trial-${trial}`;
  process.stderr.write(`\n▶ ${testName} (${agent.cli}/${agent.model})\n`);

  const sandbox = await createSandbox(evalCase, condition, treeConfig);

  try {
    // Run agent session
    const prompt = buildPrompt(evalCase, condition);
    const session = await runSession({
      prompt,
      workingDirectory: sandbox.dir,
      agent,
      maxTurns: evalCase.max_turns || 30,
      timeout: evalCase.timeout_ms || 600_000,
      testName,
    });

    // Run verification
    process.stderr.write(`  Running verification...\n`);
    const verification = runVerification(sandbox.dir, evalCase.verification, evalsRoot);

    const status = verification.passed ? '✓ PASS' : '✗ FAIL';
    process.stderr.write(`  ${status} (${verification.tests_passed}/${verification.tests_total})\n`);

    return {
      case_id: evalCase.id,
      condition: condition.label,
      trial,
      passed: verification.passed,
      tests_total: verification.tests_total,
      tests_passed: verification.tests_passed,
      input_tokens: session.costEstimate.inputTokens,
      output_tokens: session.costEstimate.outputTokens,
      cache_creation_tokens: session.costEstimate.cacheCreationTokens,
      cache_read_tokens: session.costEstimate.cacheReadTokens,
      api_calls: session.toolCalls.length,
      wall_clock_ms: session.duration,
      cost_usd: session.costEstimate.estimatedCost,
      exit_reason: session.exitReason,
      transcript: session.transcript,
      model: session.model,
      cli: agent.cli,
      error: verification.error,
      model_breakdown: session.costEstimate.modelBreakdown,
    };
  } catch (err: any) {
    process.stderr.write(`  ✗ ERROR: ${err.message}\n`);
    return {
      case_id: evalCase.id,
      condition: condition.label,
      trial,
      passed: false,
      tests_total: 0,
      tests_passed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      api_calls: 0,
      wall_clock_ms: Date.now(),
      cost_usd: 0,
      exit_reason: 'error',
      transcript: [],
      model: agent.model,
      cli: agent.cli,
      error: err.message?.slice(0, 500),
    };
  } finally {
    sandbox.cleanup();
  }
}
