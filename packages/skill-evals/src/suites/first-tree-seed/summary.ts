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
    `- sourceRepoOk: ${markdownBool(validation.sourceRepoOk)}`,
    `- treeEmptyOk: ${markdownBool(validation.treeEmptyOk)}`,
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
  const markdown = `# first-tree-seed Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedAction: ${summary.expectedAction}
- seedSkillFileReadObserved: ${markdownBool(summary.metrics.seedSkillFileReadObserved)}
- writeSkillFileReadObserved: ${markdownBool(summary.metrics.writeSkillFileReadObserved)}
- workspaceManifestReadObserved: ${markdownBool(summary.metrics.workspaceManifestReadObserved)}
- sourceWorktreeCreated: ${markdownBool(summary.metrics.sourceWorktreeCreated)}
- sourceEvidenceReadObserved: ${markdownBool(summary.metrics.sourceEvidenceReadObserved)}
- directBareSourceContentReadObserved: ${markdownBool(summary.metrics.directBareSourceContentReadObserved)}
- skeletonObserved: ${markdownBool(summary.metrics.skeletonObserved)}
- approvalRequestObserved: ${markdownBool(summary.metrics.approvalRequestObserved)}
- phase2LeafContentObserved: ${markdownBool(summary.metrics.phase2LeafContentObserved)}
- sourceRepoChanged: ${markdownBool(summary.metrics.sourceRepoChanged)}
- contextTreeChanged: ${markdownBool(summary.metrics.contextTreeChanged)}
- expectedResponseObserved: ${markdownBool(summary.metrics.expectedResponseObserved)}
- forbiddenActionHits: ${
    summary.metrics.forbiddenActionHits.length === 0 ? "none" : summary.metrics.forbiddenActionHits.join(", ")
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
    String(summary.metrics.seedSkillFileReadObserved),
    String(summary.metrics.workspaceManifestReadObserved),
    String(summary.metrics.sourceWorktreeCreated),
    String(summary.metrics.sourceEvidenceReadObserved),
    String(summary.metrics.skeletonObserved),
    String(summary.metrics.forbiddenActionHits.length + summary.metrics.forbiddenSideEffectHits.length),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_action",
    "seed_skill_read",
    "manifest_read",
    "worktree",
    "source_read",
    "skeleton",
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
