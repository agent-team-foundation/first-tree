import { FIRST_TREE_READ_PERIODIC_CASES, findFirstTreeReadPeriodicCase } from "./cases.js";
import { runFirstTreeReadCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeReadEvalCase } from "./types.js";

export { findFirstTreeReadPeriodicCase };

function selectPeriodicCases(caseId: string | null): readonly FirstTreeReadEvalCase[] {
  if (caseId === null) return FIRST_TREE_READ_PERIODIC_CASES;

  const evalCase = findFirstTreeReadPeriodicCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_READ_PERIODIC_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown first-tree-read periodic case '${caseId}'. Available periodic cases: ${available}`);
  }
  return [evalCase];
}

export async function runFirstTreeReadPeriodic(packageRootPath: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectPeriodicCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-read periodic eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeReadCase(packageRootPath, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeReadPeriodicSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
