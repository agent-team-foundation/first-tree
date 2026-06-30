import { FIRST_TREE_READ_CASES, findFirstTreeReadCase } from "./cases.js";
import {
  findFirstTreeReadPeriodicCase,
  formatFirstTreeReadPeriodicSummary,
  runFirstTreeReadPeriodic,
} from "./periodic.js";
import { runFirstTreeReadCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeReadEvalCase } from "./types.js";

export {
  findFirstTreeReadCase,
  findFirstTreeReadPeriodicCase,
  formatFirstTreeReadPeriodicSummary,
  runFirstTreeReadPeriodic,
};

export type FirstTreeReadGateOptions = CliOptions;

function selectCases(caseId: string | null): readonly FirstTreeReadEvalCase[] {
  if (caseId === null) return FIRST_TREE_READ_CASES;

  const evalCase = findFirstTreeReadCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_READ_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown case '${caseId}'. Available cases: ${available}`);
  }
  return [evalCase];
}

export async function runFirstTreeReadGate(
  packageRootPath: string,
  options: FirstTreeReadGateOptions,
): Promise<BatchSummary> {
  const selectedCases = selectCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-read eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeReadCase(packageRootPath, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeReadGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
