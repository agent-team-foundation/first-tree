import { FIRST_TREE_SEED_PERIODIC_CASES } from "./cases.js";
import { runFirstTreeSeedCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeSeedEvalCase } from "./types.js";

export function findFirstTreeSeedPeriodicCase(id: string): FirstTreeSeedEvalCase | null {
  for (const evalCase of FIRST_TREE_SEED_PERIODIC_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}

function selectPeriodicCases(caseId: string | null): readonly FirstTreeSeedEvalCase[] {
  if (caseId === null) return FIRST_TREE_SEED_PERIODIC_CASES;

  const evalCase = findFirstTreeSeedPeriodicCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_SEED_PERIODIC_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown first-tree-seed periodic case '${caseId}'. Available periodic cases: ${available}`);
  }
  return [evalCase];
}

export async function runFirstTreeSeedPeriodic(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectPeriodicCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-seed periodic eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeSeedCase(packageRoot, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeSeedPeriodicSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
