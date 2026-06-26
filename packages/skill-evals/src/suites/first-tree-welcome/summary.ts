import { writeFileSync } from "node:fs";

import type { BatchSummary, CaseRunSummary, EvalMetrics, FixtureValidation } from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

function validationRows(validation: FixtureValidation): string {
  const verifyExitCode = validation.contextTreeVerifyResult?.exitCode ?? "n/a";
  return [
    `- ok: ${markdownBool(validation.ok)}`,
    `- requiredFilesOk: ${markdownBool(validation.requiredFilesOk)}`,
    `- contextTreeVerifyExitCode: ${verifyExitCode}`,
    ...validation.errors.map((error) => `- error: ${error}`),
  ].join("\n");
}

function commandRows(metrics: EvalMetrics): string {
  if (metrics.firstTreeArgv.length === 0) return "- none";
  return metrics.firstTreeArgv.map((argv) => `- first-tree ${argv.join(" ")}`).join("\n");
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-welcome Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedAction: ${summary.expectedAction}
- skillFileReadObserved: ${markdownBool(summary.metrics.skillFileReadObserved)}
- repoEvidenceReadObserved: ${markdownBool(summary.metrics.repoEvidenceReadObserved)}
- treeEvidenceReadObserved: ${markdownBool(summary.metrics.treeEvidenceReadObserved)}
- expectedEvidenceObserved: ${markdownBool(summary.metrics.expectedEvidenceObserved)}
- expectedResponseObserved: ${markdownBool(summary.metrics.expectedResponseObserved)}
- taskOptionsObserved: ${markdownBool(summary.metrics.taskOptionsObserved)}
- chatAskCount: ${summary.metrics.chatAskCount}
- chatOptionCount: ${summary.metrics.chatOptionCount ?? "n/a"}
- sourceRepoChanged: ${markdownBool(summary.metrics.sourceRepoChanged)}
- contextTreeChanged: ${markdownBool(summary.metrics.contextTreeChanged)}
- forbiddenActionHits: ${
    summary.metrics.forbiddenActionHits.length === 0 ? "none" : summary.metrics.forbiddenActionHits.join(", ")
  }
- forbiddenClaimHits: ${
    summary.metrics.forbiddenClaimHits.length === 0 ? "none" : summary.metrics.forbiddenClaimHits.join(", ")
  }
- forbiddenSideEffectHits: ${
    summary.metrics.forbiddenSideEffectHits.length === 0 ? "none" : summary.metrics.forbiddenSideEffectHits.join(", ")
  }
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}

## Chat Command Text

${fenced(summary.metrics.chatText)}

## first-tree Command Calls

${commandRows(summary.metrics)}

## Context Tree Status

${fenced(summary.metrics.contextTreeStatus)}

## Final Response

${fenced(summary.metrics.finalResponse)}
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
    summary.expectedAction,
    String(summary.metrics.skillFileReadObserved),
    String(summary.metrics.repoEvidenceReadObserved),
    String(summary.metrics.treeEvidenceReadObserved),
    String(summary.metrics.taskOptionsObserved),
    String(
      summary.metrics.forbiddenActionHits.length +
        summary.metrics.forbiddenClaimHits.length +
        summary.metrics.forbiddenSideEffectHits.length,
    ),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_action",
    "skill_file_read",
    "repo_read",
    "tree_read",
    "task_options",
    "forbidden_hits",
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
