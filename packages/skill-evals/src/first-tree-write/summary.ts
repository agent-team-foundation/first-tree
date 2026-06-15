import { writeFileSync } from "node:fs";

import { formatCommand } from "../shared/commands.js";
import type { BatchSummary, CaseRunSummary, EvalMetrics, FixtureValidation } from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
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

  if (expectedTrigger && !metrics.writeSkillFileReadObserved) {
    notes.push("Required first-tree-write/SKILL.md load was not observed.");
  }

  if (expectedTrigger && !metrics.treeTreeSucceeded) {
    notes.push("Required first-tree tree tree listing did not succeed during model phase.");
  }

  if (expectedTrigger && !metrics.targetPathObserved) {
    notes.push("Expected target path was not observed in a tree listing or in the final planned target.");
  }

  if (!expectedTrigger && metrics.writeSkillFileReadObserved) {
    notes.push("Non-write prompt loaded first-tree-write/SKILL.md.");
  }

  if (!expectedTrigger && metrics.writeIntentInOutput) {
    notes.push("Non-write prompt produced write-specific intent text.");
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

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-write Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedTrigger: ${markdownBool(summary.expectedTrigger)}
- installedSkillSet: ${summary.installedSkillSet}
- writeSkillFileReadObserved: ${markdownBool(summary.metrics.writeSkillFileReadObserved)}
- readSkillFileReadObserved: ${markdownBool(summary.metrics.readSkillFileReadObserved)}
- treeTreeSucceeded: ${markdownBool(summary.metrics.treeTreeSucceeded)}
- targetPathObserved: ${markdownBool(summary.metrics.targetPathObserved)}
- targetObservedInTreeListing: ${markdownBool(summary.metrics.targetObservedInTreeListing)}
- targetMentionedInOutput: ${markdownBool(summary.metrics.targetMentionedInOutput)}
- writeIntentInOutput: ${markdownBool(summary.metrics.writeIntentInOutput)}
- modelFirstTreeCommandsOk: ${markdownBool(summary.metrics.modelFirstTreeCommandsOk)}
- firstTreeCalls: ${summary.metrics.firstTreeCalls}
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}

## Expected Target

\`${summary.expectedTargetPath}\`

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}

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
    summary.installedSkillSet,
    String(summary.metrics.writeSkillFileReadObserved),
    String(summary.metrics.readSkillFileReadObserved),
    String(summary.metrics.treeTreeSucceeded),
    String(summary.metrics.targetPathObserved),
    String(summary.metrics.writeIntentInOutput),
    String(summary.metrics.modelFirstTreeCommandsOk),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_trigger",
    "installed_skills",
    "write_skill_read",
    "read_skill_read",
    "treeTreeSucceeded",
    "targetPathObserved",
    "writeIntentInOutput",
    "modelFirstTreeCommandsOk",
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
