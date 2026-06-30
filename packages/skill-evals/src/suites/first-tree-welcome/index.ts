import { FIRST_TREE_WELCOME_GATE_CASES, FIRST_TREE_WELCOME_LIVE_GATE_CASES } from "./cases.js";
import { formatFirstTreeWelcomePeriodicSummary, runFirstTreeWelcomePeriodic } from "./periodic.js";
import { runFirstTreeWelcomeCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, FirstTreeWelcomeEvalCase } from "./types.js";

export function findFirstTreeWelcomeCase(id: string): FirstTreeWelcomeEvalCase | null {
  for (const evalCase of FIRST_TREE_WELCOME_GATE_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}

function selectCases(caseId: string | null): readonly FirstTreeWelcomeEvalCase[] {
  if (caseId === null) return FIRST_TREE_WELCOME_LIVE_GATE_CASES;

  const evalCase = findFirstTreeWelcomeCase(caseId);
  if (evalCase === null) {
    const available = FIRST_TREE_WELCOME_GATE_CASES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown first-tree-welcome case '${caseId}'. Available cases: ${available}`);
  }
  if (evalCase.status !== "implemented") {
    throw new Error(`first-tree-welcome case '${caseId}' is declared for floor coverage but is not implemented yet.`);
  }
  return [evalCase];
}

export async function runFirstTreeWelcomeGate(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];

  for (const evalCase of selectedCases) {
    if (!options.verbose) {
      process.stderr.write(`Running first-tree-welcome eval case: ${evalCase.id}\n`);
    }
    summaries.push(await runFirstTreeWelcomeCase(packageRoot, evalCase, options, runStartedAt));
  }

  return buildBatchSummary(summaries, runStartedAt);
}

export function formatFirstTreeWelcomeGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}

export { formatFirstTreeWelcomePeriodicSummary, runFirstTreeWelcomePeriodic };
