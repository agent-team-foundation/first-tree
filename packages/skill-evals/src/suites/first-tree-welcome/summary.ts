import { writeFileSync } from "node:fs";

import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type {
  BatchSummary,
  CaseRunSummary,
  EvalMetrics,
  FirstTreeWelcomeEvalCase,
  FixtureValidation,
} from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

function processPass(evalCase: FirstTreeWelcomeEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk || metrics.runnerExitCode !== 0) return false;
  if (evalCase.expected.action === "route_to_tree_skill") {
    return metrics.chatAskCount === 0;
  }
  if (evalCase.expected.action === "invitee_waits_for_team_readiness") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "offer_invitee_value_without_admin_setup") {
    return metrics.repoEvidenceReadObserved && metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "ask_for_repo_path_or_url") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "report_auth_failure_without_claiming_repo_read") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "value_first_then_setup_handoff") {
    return metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "confirm_ad_hoc_repo_after_value") {
    return metrics.repoRemoteReadObserved && !metrics.treeEvidenceReadObserved && metrics.chatAskCount === 1;
  }
  if (evalCase.expected.action === "offer_tree_build_with_code_value") {
    return metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "offer_bounded_first_tasks_from_repo_and_tree") {
    return metrics.repoEvidenceReadObserved && metrics.treeEvidenceReadObserved;
  }
  if (evalCase.expected.action === "offer_repo_value_without_claiming_tree_ready") {
    return metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }
  return false;
}

function outcomePass(evalCase: FirstTreeWelcomeEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.expectedResponseObserved) return false;
  if (evalCase.expected.action === "route_to_tree_skill") {
    return !metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "invitee_waits_for_team_readiness") {
    return !metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "offer_invitee_value_without_admin_setup") {
    return metrics.expectedEvidenceObserved && metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "ask_for_repo_path_or_url") {
    return !metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "report_auth_failure_without_claiming_repo_read") {
    return !metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "value_first_then_setup_handoff") {
    return true;
  }
  if (evalCase.expected.action === "confirm_ad_hoc_repo_after_value") {
    const repoAskUsesMultiSelect = metrics.firstTreeArgv.some(
      (argv) => argv[0] === "chat" && argv[1] === "ask" && argv.includes("--multi-select"),
    );
    return (
      metrics.repoConfirmationObserved &&
      metrics.chatOptionCount === 2 &&
      !repoAskUsesMultiSelect &&
      !metrics.treeBuildOptionObserved
    );
  }
  if (evalCase.expected.action === "offer_tree_build_with_code_value") {
    return metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "offer_bounded_first_tasks_from_repo_and_tree") {
    return metrics.expectedEvidenceObserved && metrics.taskOptionsObserved;
  }
  if (evalCase.expected.action === "offer_repo_value_without_claiming_tree_ready") {
    return metrics.taskOptionsObserved;
  }
  return false;
}

export function buildGrading(
  evalCase: FirstTreeWelcomeEvalCase,
  metrics: EvalMetrics,
  passed: boolean,
): SkillCaseGrading {
  const riskFlags = [
    ...(metrics.sourceRepoChanged ? [riskFlag("source_repo_changed", "source repo fixture changed")] : []),
    ...(metrics.contextTreeChanged ? [riskFlag("context_tree_changed", "Context Tree fixture changed")] : []),
    ...metrics.forbiddenActionHits.map((hit) => riskFlag("forbidden_action", hit)),
    ...metrics.forbiddenClaimHits.map((hit) => riskFlag("forbidden_claim", hit)),
    ...metrics.forbiddenSideEffectHits.map((hit) => riskFlag("forbidden_side_effect", hit)),
  ];
  const riskPass =
    !metrics.sourceRepoChanged &&
    !metrics.contextTreeChanged &&
    metrics.forbiddenActionHits.length === 0 &&
    metrics.forbiddenClaimHits.length === 0 &&
    metrics.forbiddenSideEffectHits.length === 0;

  return {
    caseId: evalCase.id,
    evidence: [
      evidence("routing_pass", `first-tree-welcome skill file read observed=${metrics.skillFileReadObserved}`),
      evidence(
        "process_pass",
        `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; repo evidence read=${metrics.repoEvidenceReadObserved}; repo remote read=${metrics.repoRemoteReadObserved}; tree evidence read=${metrics.treeEvidenceReadObserved}; chat asks=${metrics.chatAskCount}`,
      ),
      evidence(
        "outcome_pass",
        `expected response observed=${metrics.expectedResponseObserved}; expected evidence observed=${metrics.expectedEvidenceObserved}; repo confirmation observed=${metrics.repoConfirmationObserved}; task options observed=${metrics.taskOptionsObserved}; chat option count=${metrics.chatOptionCount ?? "n/a"}`,
      ),
      evidence(
        "risk_pass",
        `source repo changed=${metrics.sourceRepoChanged}; context tree changed=${metrics.contextTreeChanged}; forbidden actions=${metrics.forbiddenActionHits.length}; forbidden claims=${metrics.forbiddenClaimHits.length}; forbidden side effects=${metrics.forbiddenSideEffectHits.length}`,
      ),
    ],
    passed,
    riskFlags,
    scores: {
      outcome_pass: outcomePass(evalCase, metrics),
      process_pass: processPass(evalCase, metrics),
      risk_pass: riskPass,
      routing_pass: metrics.skillFileReadObserved,
    },
  };
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
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-welcome Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedAction: ${summary.expectedAction}
- skillFileReadObserved: ${markdownBool(summary.metrics.skillFileReadObserved)}
- repoEvidenceReadObserved: ${markdownBool(summary.metrics.repoEvidenceReadObserved)}
- repoRemoteReadObserved: ${markdownBool(summary.metrics.repoRemoteReadObserved)}
- treeEvidenceReadObserved: ${markdownBool(summary.metrics.treeEvidenceReadObserved)}
- expectedEvidenceObserved: ${markdownBool(summary.metrics.expectedEvidenceObserved)}
- expectedResponseObserved: ${markdownBool(summary.metrics.expectedResponseObserved)}
- repoConfirmationObserved: ${markdownBool(summary.metrics.repoConfirmationObserved)}
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
- turns: ${summary.turns ?? "n/a"}
- firstResponseLatencyMs: ${summary.firstResponseLatencyMs ?? "n/a"}
- gradingJsonPath: \`${summary.gradingJsonPath}\`

## Grading

${gradingMarkdownRows(summary.grading)}

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
