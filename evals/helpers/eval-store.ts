/**
 * Eval result persistence.
 *
 * EvalCollector accumulates trial results, writes them to
 * ~/.context-tree/evals/{branch}-{timestamp}.json with crash-safe
 * partial saves, and prints a summary table on finalize.
 *
 * Adapted from gstack's eval-store.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { TrialResult, EvalRun } from '#evals/helpers/types.js';
import { generateHtmlReport } from '#evals/helpers/html-report.js';
import { getEnv } from '#evals/helpers/env.js';
import { TIMEOUT_GIT_INFO } from '#evals/helpers/timeouts.js';

const SCHEMA_VERSION = 1;
const EVAL_DIR = getEnv('EVALS_STORE_DIR', '~/.context-tree/evals')!;

function getGitInfo(): { branch: string; sha: string } {
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', timeout: TIMEOUT_GIT_INFO });
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: 'pipe', timeout: TIMEOUT_GIT_INFO });
    return {
      branch: branch.stdout?.toString().trim() || 'unknown',
      sha: sha.stdout?.toString().trim() || 'unknown',
    };
  } catch {
    return { branch: 'unknown', sha: 'unknown' };
  }
}

export class EvalCollector {
  private trials: TrialResult[] = [];
  private finalized = false;
  private evalDir: string;
  private createdAt = Date.now();
  private model: string;
  private cli: string;
  private conditions: Set<string> = new Set();

  constructor(options: { model: string; cli: string; evalDir?: string }) {
    this.model = options.model;
    this.cli = options.cli;
    this.evalDir = options.evalDir || EVAL_DIR;
  }

  addTrial(trial: TrialResult): void {
    this.trials.push(trial);
    this.conditions.add(trial.condition);
    this.savePartial();
  }

  /** Atomic partial save after each trial. Non-fatal on error. */
  private savePartial(): void {
    try {
      const run = this.buildRun(true);
      fs.mkdirSync(this.evalDir, { recursive: true });
      const partialPath = path.join(this.evalDir, '_partial-eval.json');
      const tmp = partialPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n');
      fs.renameSync(tmp, partialPath);
    } catch { /* non-fatal */ }
  }

  async finalize(): Promise<string> {
    if (this.finalized) return '';
    this.finalized = true;

    const run = this.buildRun(false);

    // Write final file
    fs.mkdirSync(this.evalDir, { recursive: true });
    const dateStr = run.timestamp.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    const safeBranch = run.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
    const filename = `${safeBranch}-${dateStr}.json`;
    const filepath = path.join(this.evalDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(run, null, 2) + '\n');

    // Write HTML report
    const htmlFilename = filename.replace('.json', '.html');
    const htmlPath = path.join(this.evalDir, htmlFilename);
    const htmlContent = generateHtmlReport(this.trials, {
      model: this.model,
      cli: this.cli,
      branch: run.branch,
      sha: run.git_sha,
      timestamp: run.timestamp,
    });
    fs.writeFileSync(htmlPath, htmlContent);

    // Clean up partial file
    try { fs.unlinkSync(path.join(this.evalDir, '_partial-eval.json')); } catch { /* ignore */ }

    this.printSummary(run, filepath);
    process.stderr.write(`  HTML:  ${htmlPath}\n`);
    return filepath;
  }

  private buildRun(partial: boolean): EvalRun & { _partial?: boolean } {
    const git = getGitInfo();
    const totalCost = this.trials.reduce((s, t) => s + t.cost_usd, 0);
    const totalDuration = this.trials.reduce((s, t) => s + t.wall_clock_ms, 0);

    return {
      schema_version: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      git_sha: git.sha,
      branch: git.branch,
      hostname: os.hostname(),
      model: this.model,
      cli: this.cli,
      conditions: [...this.conditions],
      trials: this.trials,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      total_duration_ms: totalDuration,
      wall_clock_ms: Date.now() - this.createdAt,
      ...(partial ? { _partial: true } : {}),
    };
  }

  private printSummary(run: EvalRun, filepath: string): void {
    const lines: string[] = [];
    lines.push('');
    lines.push(`Eval Results — ${run.cli}/${run.model} @ ${run.branch} (${run.git_sha})`);
    lines.push('═'.repeat(75));

    // Group by condition
    const byCondition = new Map<string, TrialResult[]>();
    for (const t of this.trials) {
      const list = byCondition.get(t.condition) || [];
      list.push(t);
      byCondition.set(t.condition, list);
    }

    // If 2+ conditions, show comparison table first
    if (byCondition.size >= 2) {
      this.printComparisonTable(lines, byCondition);
    }

    for (const [condition, trials] of byCondition) {
      const passed = trials.filter(t => t.passed).length;
      const totalCost = trials.reduce((s, t) => s + t.cost_usd, 0);
      lines.push(`\n  ${condition} (${passed}/${trials.length} passed, $${totalCost.toFixed(2)})`);
      lines.push('  ' + '─'.repeat(71));

      for (const t of trials) {
        const status = t.passed ? ' PASS ' : ' FAIL ';
        const cost = `$${t.cost_usd.toFixed(2)}`;
        const dur = `${Math.round(t.wall_clock_ms / 1000)}s`;
        const inTok = Math.round(t.input_tokens / 1000);
        const outTok = Math.round(t.output_tokens / 1000);
        const tokens = `${inTok}k in/${outTok}k out`;
        const name = t.case_id.length > 30
          ? t.case_id.slice(0, 27) + '...'
          : t.case_id.padEnd(30);
        lines.push(`    ${name}  ${status}  ${cost.padStart(7)}  ${dur.padStart(5)}  ${tokens.padStart(8)}`);
      }
    }

    lines.push('\n' + '═'.repeat(75));
    const totalPassed = this.trials.filter(t => t.passed).length;
    lines.push(`  Total: ${totalPassed}/${this.trials.length} passed  $${run.total_cost_usd.toFixed(2)}  ${Math.round(run.wall_clock_ms / 1000)}s wall`);
    lines.push(`  Saved: ${filepath}`);

    process.stderr.write(lines.join('\n') + '\n');
  }

  /**
   * Print a side-by-side comparison table grouped by case, with deltas relative to baseline.
   */
  private printComparisonTable(
    lines: string[],
    byCondition: Map<string, TrialResult[]>,
  ): void {
    lines.push('\n  Comparison (vs baseline)');
    lines.push('  ' + '═'.repeat(71));

    // Collect all case IDs
    const caseIds = [...new Set(this.trials.map(t => t.case_id))];
    const conditionLabels = [...byCondition.keys()];

    // Build baseline lookup: case_id -> averaged metrics
    const baselineTrials = byCondition.get('baseline') || [];
    const baselineByCase = new Map<string, { pass: number; total: number; cost: number; time: number; inTok: number; outTok: number }>();
    for (const caseId of caseIds) {
      const trials = baselineTrials.filter(t => t.case_id === caseId);
      if (trials.length === 0) continue;
      baselineByCase.set(caseId, {
        pass: trials.filter(t => t.passed).length,
        total: trials.length,
        cost: trials.reduce((s, t) => s + t.cost_usd, 0) / trials.length,
        time: trials.reduce((s, t) => s + t.wall_clock_ms, 0) / trials.length,
        inTok: trials.reduce((s, t) => s + t.input_tokens, 0) / trials.length,
        outTok: trials.reduce((s, t) => s + t.output_tokens, 0) / trials.length,
      });
    }

    for (const caseId of caseIds) {
      const name = caseId.length > 30 ? caseId.slice(0, 27) + '...' : caseId;
      lines.push(`\n    ${name}`);
      lines.push('    ' + '─'.repeat(67));
      lines.push('    Condition'.padEnd(24) + 'Pass  Cost     Time   Tokens        Delta');

      const baseline = baselineByCase.get(caseId);

      for (const label of conditionLabels) {
        const trials = (byCondition.get(label) || []).filter(t => t.case_id === caseId);
        if (trials.length === 0) continue;

        const pass = trials.filter(t => t.passed).length;
        const total = trials.length;
        const avgCost = trials.reduce((s, t) => s + t.cost_usd, 0) / total;
        const avgTime = trials.reduce((s, t) => s + t.wall_clock_ms, 0) / total;
        const avgIn = trials.reduce((s, t) => s + t.input_tokens, 0) / total;
        const avgOut = trials.reduce((s, t) => s + t.output_tokens, 0) / total;

        const passStr = `${pass}/${total}`;
        const costStr = `$${avgCost.toFixed(2)}`;
        const timeStr = `${Math.round(avgTime / 1000)}s`;
        const tokStr = `${Math.round(avgIn / 1000)}k/${Math.round(avgOut / 1000)}k`;

        let delta = '—';
        if (baseline && label !== 'baseline') {
          const costDelta = baseline.cost > 0
            ? Math.round(((avgCost - baseline.cost) / baseline.cost) * 100)
            : 0;
          const sign = costDelta <= 0 ? '' : '+';
          delta = `${sign}${costDelta}% cost`;
        }

        lines.push(
          `    ${label.padEnd(20)}${passStr.padEnd(6)}${costStr.padStart(7)}  ${timeStr.padStart(5)}  ${tokStr.padStart(12)}  ${delta}`,
        );
      }
    }

    lines.push('\n  ' + '═'.repeat(71));
  }
}
