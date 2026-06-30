import { FIRST_TREE_SEED_GATE_CASES } from "./cases.js";

export {
  findFirstTreeSeedPeriodicCase,
  formatFirstTreeSeedPeriodicSummary,
  runFirstTreeSeedPeriodic,
} from "./periodic.js";

import { runFirstTreeSeedCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeSeedEvalCase } from "./types.js";

export function findFirstTreeSeedCase(id: string): FirstTreeSeedEvalCase | null {
  for (const evalCase of FIRST_TREE_SEED_GATE_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}

function selectCases(caseId: string | null): readonly FirstTreeSeedEvalCase[] {
  if (caseId === null) return FIRST_TREE_SEED_GATE_CASES;

  const evalCase = findFirstTreeSeedCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_SEED_GATE_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown first-tree-seed case '${caseId}'. Available cases: ${available}`);
  }
  return [evalCase];
}

export async function runFirstTreeSeedGate(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-seed eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeSeedCase(packageRoot, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeSeedGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
