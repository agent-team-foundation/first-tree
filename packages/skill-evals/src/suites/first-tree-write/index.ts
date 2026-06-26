import { FIRST_TREE_WRITE_GATE_CASES } from "./cases.js";
import { runFirstTreeWriteCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeWriteEvalCase } from "./types.js";

export function findFirstTreeWriteCase(id: string): FirstTreeWriteEvalCase | null {
  for (const evalCase of FIRST_TREE_WRITE_GATE_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}

function selectCases(caseId: string | null): readonly FirstTreeWriteEvalCase[] {
  if (caseId === null) return FIRST_TREE_WRITE_GATE_CASES;

  const evalCase = findFirstTreeWriteCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_WRITE_GATE_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown first-tree-write case '${caseId}'. Available cases: ${available}`);
  }
  return [evalCase];
}

export async function runFirstTreeWriteGate(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-write eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeWriteCase(packageRoot, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeWriteGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
