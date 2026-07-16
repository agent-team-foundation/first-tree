import { writeFileSync } from "node:fs";

import { gradingMarkdownRows, writeGradingJson } from "../../core/grading.js";
import type { BatchSummary, CaseRunSummary } from "./types.js";

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const markdown = [
    `# ${summary.caseId}`,
    "",
    `- passed: ${String(summary.passed)}`,
    `- expectedStatus: ${summary.expectedAction}`,
    `- skillFileReadObserved: ${String(summary.metrics.skillFileReadObserved)}`,
    `- attemptedCapabilities: ${String(summary.metrics.attemptedCapabilities.length)}`,
    `- readinessComplete: ${String(summary.metrics.readinessComplete)}`,
    `- planAfterReadiness: ${String(summary.metrics.planAfterReadiness)}`,
    `- taskAfterPlan: ${String(summary.metrics.taskAfterPlan)}`,
    `- sourceRepoChanged: ${String(summary.metrics.sourceRepoChanged)}`,
    `- runnerExitCode: ${String(summary.metrics.runnerExitCode)}`,
    "",
    "## Grading",
    "",
    gradingMarkdownRows(summary.grading),
    "",
    "## Final Response",
    "",
    fenced(summary.metrics.finalResponse),
    "",
    "## QA Report",
    "",
    fenced(summary.metrics.reportText),
    "",
    "## Paths",
    "",
    `- runRoot: ${summary.runRoot}`,
    `- workspacePath: ${summary.workspacePath}`,
    "",
  ].join("\n");
  writeFileSync(summary.summaryMdPath, markdown, "utf8");
}

export function buildBatchSummary(cases: readonly CaseRunSummary[], runStartedAt: string): BatchSummary {
  const passed = cases.filter((summary) => summary.passed).length;
  return {
    cases,
    failed: cases.length - passed,
    passed,
    runStartedAt,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatSummaryTable(batch: BatchSummary): string {
  const header = ["case_id", "status", "attempted", "ready", "plan_after_ready", "task_after_plan", "passed"];
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    summary.expectedAction,
    String(summary.metrics.attemptedCapabilities.length),
    String(summary.metrics.readinessComplete),
    String(summary.metrics.planAfterReadiness),
    String(summary.metrics.taskAfterPlan),
    String(summary.passed),
  ]);
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0)));
  return [
    header.map((label, index) => pad(label, widths[index] ?? label.length)).join("  "),
    ...rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  ")),
  ].join("\n");
}
