import { writeFileSync } from "node:fs";

import type { BatchSummary, CaseRunSummary, EvalMetrics, FixtureValidation } from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

export function driftNote(metrics: EvalMetrics): string | null {
  if (!metrics.helpAttempted) return null;
  const exitCodes = metrics.helpExitCodes.length > 0 ? metrics.helpExitCodes.join(", ") : "not captured";
  const hasNonZeroExit = metrics.helpExitCodes.some((exitCode) => exitCode !== 0);

  if (hasNonZeroExit) {
    return `first-tree-dev tree tree --help was attempted and returned non-zero exit code(s): ${exitCodes}.`;
  }

  return [
    "first-tree-dev tree tree --help was attempted.",
    "The current CLI returns parent tree help with exit 0 for this --help form even though only tree verify is registered.",
    "This still records first-tree-read selector drift.",
  ].join(" ");
}

function validationRows(validation: FixtureValidation): string {
  return [
    `- ok: ${markdownBool(validation.ok)}`,
    `- domainNodeCount: ${validation.domainNodeCount}`,
    `- minDepthOk: ${markdownBool(validation.minDepthOk)}`,
    `- requiredFilesOk: ${markdownBool(validation.requiredFilesOk)}`,
    `- verifyExitCode: ${validation.verifyResult ? validation.verifyResult.exitCode : "n/a"}`,
    ...validation.errors.map((error) => `- error: ${error}`),
  ].join("\n");
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-read Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedTrigger: ${markdownBool(summary.expectedTrigger)}
- skillHit: ${markdownBool(summary.metrics.skillHit)}
- helpCalls: ${summary.metrics.helpCalls}
- firstTreeDevCalls: ${summary.metrics.firstTreeDevCalls}
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}
${drift}
## Paths

- runRoot: \`${summary.runRoot}\`
- workspacePath: \`${summary.workspacePath}\`
`;

  writeFileSync(summary.summaryMdPath, markdown, "utf8");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function formatSummaryTable(batch: BatchSummary): string {
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    String(summary.expectedTrigger),
    String(summary.metrics.skillHit),
    String(summary.metrics.helpCalls),
    String(summary.metrics.firstTreeDevCalls),
    String(summary.passed),
  ]);
  const header = ["case_id", "expected_trigger", "skill_hit", "help_calls", "first_tree_dev_calls", "passed"];
  const widths = header.map((label, index) => {
    let width = label.length;
    for (const row of rows) {
      const value = row[index];
      if (value && value.length > width) width = value.length;
    }
    return width;
  });

  const lines = [
    header.map((label, index) => pad(label, widths[index] ?? label.length)).join("  "),
    ...rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  ")),
  ];

  return lines.join("\n");
}

export function buildBatchSummary(cases: readonly CaseRunSummary[], runStartedAt: string): BatchSummary {
  let passed = 0;
  for (const summary of cases) {
    if (summary.passed) passed += 1;
  }

  return {
    cases,
    failed: cases.length - passed,
    passed,
    runStartedAt,
  };
}
