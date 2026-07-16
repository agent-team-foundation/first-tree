import { FIRST_TREE_QA_LIVE_GATE_CASES } from "./cases.js";
import { runFirstTreeQaCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeQaEvalCase } from "./types.js";

export function findFirstTreeQaCase(id: string): FirstTreeQaEvalCase | null {
  return FIRST_TREE_QA_LIVE_GATE_CASES.find((evalCase) => evalCase.id === id) ?? null;
}

function selectCases(caseId: string | null): readonly FirstTreeQaEvalCase[] {
  if (caseId === null) return FIRST_TREE_QA_LIVE_GATE_CASES;
  const evalCase = findFirstTreeQaCase(caseId);
  if (evalCase !== null) return [evalCase];
  throw new Error(
    "Unknown first-tree-qa case '" +
      caseId +
      "'. Available cases: " +
      FIRST_TREE_QA_LIVE_GATE_CASES.map((candidate) => candidate.id).join(", "),
  );
}

export async function runFirstTreeQaGate(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];
  for (const evalCase of selectedCases) {
    if (!options.verbose) process.stderr.write(`Running first-tree-qa eval case: ${evalCase.id}\n`);
    summaries.push(await runFirstTreeQaCase(packageRoot, evalCase, options, runStartedAt));
  }
  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeQaGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
