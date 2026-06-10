import { writeFileSync } from "node:fs";

import type { BatchSummary, CaseRunSummary, EvalMetrics, FixtureValidation } from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function formatArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(arg)) return arg;
  return JSON.stringify(arg);
}

function formatCommand(argv: readonly string[]): string {
  return argv.map(formatArg).join(" ");
}

export function driftNote(metrics: EvalMetrics, expectedTrigger: boolean): string | null {
  const notes: string[] = [];
  const nonZeroResults = metrics.firstTreeCommandResults.filter((result) => result.exitCode !== 0);

  if (nonZeroResults.length > 0) {
    const detail = nonZeroResults
      .map((result) => `first-tree ${formatCommand(result.argv)} => ${result.exitCode}`)
      .join("; ");
    notes.push(`first-tree command(s) returned non-zero exit code(s): ${detail}.`);
  }

  if (expectedTrigger && !metrics.expectedFactsObserved) {
    notes.push(
      "Expected Context Tree facts were not surfaced in the model output; inspect events.jsonl for the final assistant messages.",
    );
  }

  if (!expectedTrigger && metrics.expectedFactHits.length > 0) {
    notes.push(`Off-topic case surfaced Context Tree fact(s): ${metrics.expectedFactHits.join(" | ")}.`);
  }

  return notes.length > 0 ? notes.join(" ") : null;
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

function commandResultRows(metrics: EvalMetrics): string {
  if (metrics.firstTreeCommandResults.length === 0) return "- none";
  return metrics.firstTreeCommandResults
    .map((result) => `- first-tree ${formatCommand(result.argv)}: exit=${result.exitCode}`)
    .join("\n");
}

function expectedFactRows(metrics: EvalMetrics): string {
  if (metrics.expectedFactHits.length === 0) return "- none";
  return metrics.expectedFactHits.map((fact) => `- ${fact}`).join("\n");
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-read Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedTrigger: ${markdownBool(summary.expectedTrigger)}
- skillHit: ${markdownBool(summary.metrics.skillHit)}
- skillFileReadObserved: ${markdownBool(summary.metrics.skillFileReadObserved)}
- expectedFactsObserved: ${markdownBool(summary.metrics.expectedFactsObserved)}
- firstTreeCalls: ${summary.metrics.firstTreeCalls}
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}

## Expected Fact Hits

${expectedFactRows(summary.metrics)}

## first-tree Command Results

${commandResultRows(summary.metrics)}
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
    String(summary.metrics.firstTreeCalls),
    String(summary.metrics.skillFileReadObserved),
    String(summary.metrics.expectedFactsObserved),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_trigger",
    "skill_hit",
    "first_tree_calls",
    "skill_file_read",
    "expected_facts_observed",
    "passed",
  ];
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
