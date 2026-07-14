import { CONTEXT_TREE_REVIEW_GATE_CASES } from "./cases.js";
import { runContextTreeReviewCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions } from "./types.js";

export async function runContextTreeReviewGate(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const cases = options.caseId
    ? CONTEXT_TREE_REVIEW_GATE_CASES.filter((item) => item.id === options.caseId)
    : CONTEXT_TREE_REVIEW_GATE_CASES;
  if (cases.length === 0) throw new Error(`Unknown context-tree-review case '${options.caseId}'.`);
  const startedAt = new Date().toISOString();
  const summaries = [];
  for (const evalCase of cases)
    summaries.push(await runContextTreeReviewCase(packageRoot, evalCase, options, startedAt));
  return buildBatchSummary(summaries, startedAt);
}

export function formatContextTreeReviewGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
