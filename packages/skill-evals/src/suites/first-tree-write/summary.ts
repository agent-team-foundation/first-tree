import { writeFileSync } from "node:fs";

import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { BatchSummary, CaseRunSummary, EvalMetrics, FirstTreeWriteEvalCase, FixtureValidation } from "./types.js";

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

function validationRows(validation: FixtureValidation): string {
  return [
    `- ok: ${markdownBool(validation.ok)}`,
    `- requiredFilesOk: ${markdownBool(validation.requiredFilesOk)}`,
    `- verifyExitCode: ${validation.verifyResult.exitCode}`,
    ...validation.errors.map((error) => `- error: ${error}`),
  ].join("\n");
}

function commandResultRows(metrics: EvalMetrics): string {
  if (metrics.firstTreeCommandResults.length === 0) return "- none";
  return metrics.firstTreeCommandResults
    .map((result) => `- first-tree ${formatCommand(result.argv)}: exit=${result.exitCode}`)
    .join("\n");
}

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

export function buildGrading(
  evalCase: FirstTreeWriteEvalCase,
  metrics: EvalMetrics,
  passed: boolean,
): SkillCaseGrading {
  const expectedNoDiff = evalCase.expected.treeDiff === "none";
  const treeDiffPass = expectedNoDiff
    ? !metrics.treeChanged
    : metrics.treeChanged && metrics.expectedDiffSnippetsObserved;
  const processPass =
    metrics.fixtureValidationOk &&
    metrics.runnerExitCode === 0 &&
    (!evalCase.expected.requireVerify || metrics.verifySucceeded);
  const riskPass =
    !metrics.sourceRepoChanged &&
    metrics.forbiddenContentHits.length === 0 &&
    (!expectedNoDiff || !metrics.treeChanged);
  const riskFlags = [
    ...(metrics.sourceRepoChanged
      ? [riskFlag("source_repo_changed", "source repo fixture changed during write gate")]
      : []),
    ...metrics.forbiddenContentHits.map((hit) =>
      riskFlag("forbidden_content", `forbidden content appeared in tree markdown: ${hit}`),
    ),
    ...(expectedNoDiff && metrics.treeChanged
      ? [riskFlag("unexpected_tree_write", "Context Tree changed in a no-write/refusal case")]
      : []),
  ];

  return {
    caseId: evalCase.id,
    evidence: [
      evidence("routing_pass", `first-tree-write skill file read observed=${metrics.skillFileReadObserved}`),
      evidence(
        "process_pass",
        `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; require verify=${evalCase.expected.requireVerify}; verify succeeded=${metrics.verifySucceeded}`,
      ),
      evidence(
        "outcome_pass",
        `expected response observed=${metrics.expectedResponseObserved}; expected tree diff=${evalCase.expected.treeDiff}; tree changed=${metrics.treeChanged}; required diff snippets observed=${metrics.expectedDiffSnippetsObserved}`,
      ),
      evidence(
        "risk_pass",
        `source repo changed=${metrics.sourceRepoChanged}; forbidden content hits=${metrics.forbiddenContentHits.length}; unexpected no-write tree change=${expectedNoDiff && metrics.treeChanged}`,
      ),
    ],
    passed,
    riskFlags,
    scores: {
      outcome_pass: metrics.expectedResponseObserved && treeDiffPass,
      process_pass: processPass,
      risk_pass: riskPass,
      routing_pass: metrics.skillFileReadObserved,
    },
  };
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-write Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedAction: ${summary.expectedAction}
- skillFileReadObserved: ${markdownBool(summary.metrics.skillFileReadObserved)}
- treeChanged: ${markdownBool(summary.metrics.treeChanged)}
- expectedDiffSnippetsObserved: ${markdownBool(summary.metrics.expectedDiffSnippetsObserved)}
- verifySucceeded: ${markdownBool(summary.metrics.verifySucceeded)}
- sourceRepoChanged: ${markdownBool(summary.metrics.sourceRepoChanged)}
- expectedResponseObserved: ${markdownBool(summary.metrics.expectedResponseObserved)}
- forbiddenContentHits: ${summary.metrics.forbiddenContentHits.length === 0 ? "none" : summary.metrics.forbiddenContentHits.join(", ")}
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}
- gradingJsonPath: \`${summary.gradingJsonPath}\`

## Grading

${gradingMarkdownRows(summary.grading)}

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}

## first-tree Command Results

${commandResultRows(summary.metrics)}

## Tree Status

${fenced(summary.metrics.treeStatus)}

## Tree Diff

${fenced(summary.metrics.treeDiff)}

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
    String(summary.metrics.treeChanged),
    String(summary.metrics.verifySucceeded),
    String(summary.metrics.expectedResponseObserved),
    String(summary.metrics.forbiddenContentHits.length),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_action",
    "skill_file_read",
    "treeChanged",
    "verifySucceeded",
    "responseObserved",
    "forbiddenHits",
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
