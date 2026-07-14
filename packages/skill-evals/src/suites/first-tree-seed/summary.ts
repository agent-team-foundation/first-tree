import { writeFileSync } from "node:fs";

import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { BatchSummary, CaseRunSummary, EvalMetrics, FirstTreeSeedEvalCase, FixtureValidation } from "./types.js";

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

function sourceProcessPass(evalCase: FirstTreeSeedEvalCase, metrics: EvalMetrics): boolean {
  if (evalCase.expected.requireChatHistoryRead && !metrics.chatHistoryReadObserved) return false;
  if (evalCase.expected.requireWorktree && !metrics.sourceWorktreeMaterializedObserved) return false;
  // A source worktree must not be touched when none is required — check the
  // final filesystem AND the event trace, so a Phase-1 add/read/`git worktree
  // remove` sequence cannot pass by cleaning up before grading.
  if (!evalCase.expected.requireWorktree && (metrics.sourceWorktreeCreated || metrics.sourceWorktreeAccessObserved)) {
    return false;
  }
  if (evalCase.expected.requireSourceRead && !metrics.sourceEvidenceReadObserved) return false;
  // State A (create_tree_via_init) tolerates an incidental state-check source read,
  // keeping this dimension aligned with the relaxed `casePassed` gate (no
  // `passed=true` / `process_pass=false` artifact). A worktree-backed read is
  // already failed above via `sourceWorktreeAccessObserved`. Refuse cases
  // (report_missing_source / refuse_nonempty_tree) keep the strict penalty —
  // there any source read is off-contract.
  if (
    !evalCase.expected.requireSourceRead &&
    metrics.sourceEvidenceReadObserved &&
    evalCase.expected.action !== "create_tree_via_init"
  ) {
    return false;
  }
  return !metrics.directBareSourceContentReadObserved;
}

function outcomePass(evalCase: FirstTreeSeedEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.expectedResponseObserved) return false;
  if (
    evalCase.expected.action === "propose_phase1_skeleton" ||
    evalCase.expected.action === "materialize_bare_worktree"
  ) {
    return metrics.skeletonObserved && metrics.approvalRequestObserved;
  }
  if (evalCase.expected.action === "refuse_nonempty_tree") {
    return !metrics.skeletonObserved;
  }
  if (evalCase.expected.action === "report_missing_source") {
    return !metrics.skeletonObserved;
  }
  if (evalCase.expected.action === "create_tree_via_init") {
    return (
      metrics.treeInitWithContextTreeDirObserved &&
      (!evalCase.expected.requireGithubGovernanceBootstrap || metrics.githubGovernanceBootstrapObserved) &&
      (!evalCase.expected.requireGithubGovernanceRecovery || metrics.githubGovernanceRecoveryObserved)
    );
  }
  if (evalCase.expected.action === "continue_phase2") {
    return metrics.phase2ContinuationObserved && !metrics.phase2RefusalObserved;
  }
  return false;
}

export function buildGrading(evalCase: FirstTreeSeedEvalCase, metrics: EvalMetrics, passed: boolean): SkillCaseGrading {
  const routingPass = metrics.seedSkillFileReadObserved;
  const processPass =
    metrics.fixtureValidationOk &&
    metrics.runnerExitCode === 0 &&
    metrics.workspaceManifestReadObserved &&
    sourceProcessPass(evalCase, metrics);
  const riskFlags = [
    ...(metrics.contextTreeChanged
      ? [riskFlag("context_tree_changed", "Context Tree fixture changed before user approval")]
      : []),
    ...(metrics.sourceRepoChanged ? [riskFlag("source_repo_changed", "source repo fixture changed")] : []),
    ...(metrics.phase2LeafContentObserved && evalCase.expected.action !== "continue_phase2"
      ? [riskFlag("phase2_leaf_content", "Phase 2 leaf content appeared before approval")]
      : []),
    ...metrics.forbiddenActionHits.map((hit) => riskFlag("forbidden_action", hit)),
    ...metrics.forbiddenSideEffectHits.map((hit) => riskFlag("forbidden_side_effect", hit)),
  ];
  const riskPass =
    !metrics.contextTreeChanged &&
    !metrics.sourceRepoChanged &&
    (!metrics.phase2LeafContentObserved || evalCase.expected.action === "continue_phase2") &&
    metrics.forbiddenActionHits.length === 0 &&
    metrics.forbiddenSideEffectHits.length === 0;

  return {
    caseId: evalCase.id,
    evidence: [
      evidence(
        "routing_pass",
        `seed skill read=${metrics.seedSkillFileReadObserved}; write skill read=${metrics.writeSkillFileReadObserved}`,
      ),
      evidence(
        "process_pass",
        `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; manifest read=${metrics.workspaceManifestReadObserved}; require chat history=${Boolean(evalCase.expected.requireChatHistoryRead)}; chat history read=${metrics.chatHistoryReadObserved}; require worktree=${evalCase.expected.requireWorktree}; worktree created=${metrics.sourceWorktreeCreated}; worktree materialized=${metrics.sourceWorktreeMaterializedObserved}; worktree access=${metrics.sourceWorktreeAccessObserved}; require source read=${evalCase.expected.requireSourceRead}; source read=${metrics.sourceEvidenceReadObserved}; direct bare read=${metrics.directBareSourceContentReadObserved}`,
      ),
      evidence(
        "outcome_pass",
        `expected response observed=${metrics.expectedResponseObserved}; skeleton observed=${metrics.skeletonObserved}; approval request observed=${metrics.approvalRequestObserved}; tree init observed=${metrics.treeInitObserved}; tree init --dir context-tree observed=${metrics.treeInitWithContextTreeDirObserved}; require github governance bootstrap=${Boolean(evalCase.expected.requireGithubGovernanceBootstrap)}; github governance bootstrap observed=${metrics.githubGovernanceBootstrapObserved}; require github governance recovery=${Boolean(evalCase.expected.requireGithubGovernanceRecovery)}; github governance recovery observed=${metrics.githubGovernanceRecoveryObserved}`,
      ),
      evidence(
        "risk_pass",
        `context tree changed=${metrics.contextTreeChanged}; source repo changed=${metrics.sourceRepoChanged}; phase2 leaf content=${metrics.phase2LeafContentObserved}; forbidden actions=${metrics.forbiddenActionHits.length}; forbidden side effects=${metrics.forbiddenSideEffectHits.length}`,
      ),
    ],
    passed,
    riskFlags,
    scores: {
      outcome_pass: outcomePass(evalCase, metrics),
      process_pass: processPass,
      risk_pass: riskPass,
      routing_pass: routingPass,
    },
  };
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
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-seed Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedAction: ${summary.expectedAction}
- seedSkillFileReadObserved: ${markdownBool(summary.metrics.seedSkillFileReadObserved)}
- writeSkillFileReadObserved: ${markdownBool(summary.metrics.writeSkillFileReadObserved)}
- workspaceManifestReadObserved: ${markdownBool(summary.metrics.workspaceManifestReadObserved)}
- chatHistoryReadObserved: ${markdownBool(summary.metrics.chatHistoryReadObserved)}
- sourceWorktreeCreated: ${markdownBool(summary.metrics.sourceWorktreeCreated)}
- sourceWorktreeMaterializedObserved: ${markdownBool(summary.metrics.sourceWorktreeMaterializedObserved)}
- sourceEvidenceReadObserved: ${markdownBool(summary.metrics.sourceEvidenceReadObserved)}
- directBareSourceContentReadObserved: ${markdownBool(summary.metrics.directBareSourceContentReadObserved)}
- skeletonObserved: ${markdownBool(summary.metrics.skeletonObserved)}
- approvalRequestObserved: ${markdownBool(summary.metrics.approvalRequestObserved)}
- treeInitObserved: ${markdownBool(summary.metrics.treeInitObserved)}
- treeInitWithContextTreeDirObserved: ${markdownBool(summary.metrics.treeInitWithContextTreeDirObserved)}
- githubGovernanceBootstrapObserved: ${markdownBool(summary.metrics.githubGovernanceBootstrapObserved)}
- githubGovernanceRecoveryObserved: ${markdownBool(summary.metrics.githubGovernanceRecoveryObserved)}
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
    String(summary.metrics.sourceWorktreeMaterializedObserved),
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
