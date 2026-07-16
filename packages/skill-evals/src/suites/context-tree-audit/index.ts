import { CONTEXT_TREE_AUDIT_GATE_CASES } from "./cases.js";
import { runContextTreeAuditCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { AuditBatchSummary, CliOptions } from "./types.js";

export async function runContextTreeAuditGate(packageRoot: string, options: CliOptions): Promise<AuditBatchSummary> {
  const cases = options.caseId
    ? CONTEXT_TREE_AUDIT_GATE_CASES.filter((item) => item.id === options.caseId)
    : CONTEXT_TREE_AUDIT_GATE_CASES;
  if (cases.length === 0) throw new Error(`Unknown context-tree-audit case '${options.caseId}'.`);
  const startedAt = new Date().toISOString();
  const summaries = [];
  for (const evalCase of cases)
    summaries.push(await runContextTreeAuditCase(packageRoot, evalCase, options, startedAt));
  return buildBatchSummary(summaries, startedAt);
}

export function formatContextTreeAuditGateSummary(batch: AuditBatchSummary): string {
  return formatSummaryTable(batch);
}
