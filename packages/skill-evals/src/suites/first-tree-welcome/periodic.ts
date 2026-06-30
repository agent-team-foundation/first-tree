import { FIRST_TREE_WELCOME_LIVE_PERIODIC_CASES, FIRST_TREE_WELCOME_PERIODIC_CASES } from "./cases.js";
import { runFirstTreeWelcomeCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeWelcomeEvalCase } from "./types.js";

export function findFirstTreeWelcomePeriodicCase(id: string): FirstTreeWelcomeEvalCase | null {
  for (const evalCase of FIRST_TREE_WELCOME_PERIODIC_CASES) {
    if (evalCase.id === id || evalCase.id === `${id}-periodic`) return evalCase;
  }
  return null;
}

function selectPeriodicCases(caseId: string | null): readonly FirstTreeWelcomeEvalCase[] {
  if (caseId === null) return FIRST_TREE_WELCOME_LIVE_PERIODIC_CASES;

  const evalCase = findFirstTreeWelcomePeriodicCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_WELCOME_PERIODIC_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown first-tree-welcome periodic case '${caseId}'. Available periodic cases: ${available}`);
  }
  if (evalCase.status !== "implemented") {
    throw new Error(`first-tree-welcome periodic case '${caseId}' is declared but is not implemented yet.`);
  }
  return [evalCase];
}

export async function runFirstTreeWelcomePeriodic(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectPeriodicCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-welcome periodic eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeWelcomeCase(packageRoot, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeWelcomePeriodicSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
