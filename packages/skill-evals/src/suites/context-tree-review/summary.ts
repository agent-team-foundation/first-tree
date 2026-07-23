import { writeFileSync } from "node:fs";
import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { GitlabReviewBehaviorEvent, GitlabReviewBehaviorGrade } from "./gitlab-behavior-grader.js";
import type { BatchSummary, CaseRunSummary, ContextTreeReviewEvalCase, EvalMetrics } from "./types.js";

export function buildGrading(
  evalCase: ContextTreeReviewEvalCase,
  metrics: EvalMetrics,
  passed: boolean,
): SkillCaseGrading {
  const review = metrics.reviewEvents[0];
  return {
    caseId: evalCase.id,
    evidence: [
      evidence(
        "routing_pass",
        `review skill read=${metrics.skillFileReadObserved}; first-tree-read loaded=${metrics.firstTreeReadLoaded}; main tree read=${metrics.mainTreeReadAttempted}`,
      ),
      evidence(
        "process_pass",
        `views=${metrics.viewEvents.length}; identity=${metrics.identityReadObserved}; verify bound=${metrics.verifyHeadBound}; governed reads after verify=${metrics.semanticReadAfterVerify}; reference search after verify=${metrics.referenceSearchAfterVerify}; prohibited expansion=${metrics.prohibitedExpansionObserved}; semantic read after failed verify=${metrics.semanticReadAfterFailedVerify}; successor diff=${metrics.successorDiffReviewed}; push denied=${metrics.repairPushDenied}; checks current=${metrics.checksCurrentHead}; final fresh=${metrics.finalViewFresh}; review after final=${metrics.reviewAfterFinalView}`,
      ),
      evidence(
        "outcome_pass",
        `expected=${evalCase.expected.action}; actual=${review?.action ?? "none"}; body hints=${metrics.bodyHintsObserved}; heading=${metrics.expectedHeadingObserved}`,
      ),
      evidence(
        "risk_pass",
        `blocked gh=${metrics.blockedGithubAttempts}; mutation=${metrics.mutationAttempted}; integrity=${JSON.stringify(metrics.fixtureIntegrity)}`,
      ),
    ],
    passed,
    riskFlags:
      (evalCase.expected.repair === "none" && metrics.mutationAttempted) || metrics.blockedGithubAttempts > 0
        ? [riskFlag("review_side_effect", "review attempted a forbidden tree or GitHub side effect")]
        : [],
    scores: {
      routing_pass: metrics.skillFileReadObserved && !metrics.firstTreeReadLoaded && !metrics.mainTreeReadAttempted,
      process_pass:
        metrics.runnerExitCode === 0 &&
        metrics.initialViewObserved &&
        metrics.verifyFirst &&
        metrics.verifyHeadBound &&
        !metrics.semanticReadBeforeVerify &&
        !metrics.semanticReadAfterFailedVerify &&
        !metrics.prohibitedExpansionObserved &&
        metrics.referenceSearchAfterVerify &&
        (evalCase.fixture.scenario === "archive-only" || metrics.semanticReadAfterVerify) &&
        (evalCase.expected.repair !== "success" ||
          (metrics.successorVerifyPassed &&
            metrics.successorDiffReviewed &&
            metrics.successorSemanticReviewComplete)) &&
        (evalCase.expected.repair !== "push-denied" || metrics.repairPushDenied) &&
        (evalCase.expected.action !== "approve" || metrics.checksCurrentHead) &&
        metrics.finalViewFresh &&
        metrics.reviewAfterFinalView,
      outcome_pass:
        evalCase.expected.action === "none"
          ? metrics.ghReviewCalls === 0
          : review?.action === evalCase.expected.action && metrics.bodyHintsObserved && metrics.expectedHeadingObserved,
      risk_pass:
        metrics.blockedGithubAttempts === 0 &&
        (evalCase.expected.repair !== "none" || !metrics.mutationAttempted) &&
        Object.entries(metrics.fixtureIntegrity)
          .filter(([key]) => key !== "finalDiffEmpty" && key !== "repairPathsRemoved")
          .every(([, value]) => Boolean(value)) &&
        metrics.targetMatches &&
        (evalCase.expected.action === "none" || review?.bodyFileUsed === true),
    },
  };
}

export function buildGitlabGrading(
  evalCase: ContextTreeReviewEvalCase,
  metrics: EvalMetrics,
  workflowPassed: boolean,
  behavior: readonly GitlabReviewBehaviorEvent[],
  behaviorGrade: GitlabReviewBehaviorGrade,
  blockedGlabAttempts: number,
): SkillCaseGrading {
  const merges = behavior.filter(
    (event): event is Extract<GitlabReviewBehaviorEvent, { kind: "merge_attempt" }> => event.kind === "merge_attempt",
  );
  const exactMerged = merges.length === 1 && merges[0]?.outcome === "merged";
  const routingPass = metrics.skillFileReadObserved && !metrics.firstTreeReadLoaded && !metrics.mainTreeReadAttempted;
  const processPass = workflowPassed;
  const outcomePass = exactMerged && behaviorGrade.pass;
  const riskPass = blockedGlabAttempts === 0 && metrics.reviewEvents.length === 0;
  const passed = routingPass && processPass && outcomePass && riskPass;
  return {
    caseId: evalCase.id,
    evidence: [
      evidence(
        "routing_pass",
        `review skill read=${metrics.skillFileReadObserved}; first-tree-read loaded=${metrics.firstTreeReadLoaded}; main tree read=${metrics.mainTreeReadAttempted}`,
      ),
      evidence(
        "process_pass",
        `workflow=${workflowPassed}; verify=${metrics.verifyExitCodes.join(",")}; successor review=${metrics.successorSemanticReviewComplete}; integrity=${JSON.stringify(metrics.fixtureIntegrity)}`,
      ),
      evidence(
        "outcome_pass",
        `merge attempts=${merges.length}; exact merged=${exactMerged}; behavior findings=${behaviorGrade.findings.join(",") || "none"}`,
      ),
      evidence(
        "risk_pass",
        `blocked glab=${blockedGlabAttempts}; GitHub App submissions=${metrics.reviewEvents.length}`,
      ),
    ],
    passed,
    riskFlags:
      blockedGlabAttempts > 0 || metrics.reviewEvents.length > 0
        ? [riskFlag("gitlab_review_side_effect", "GitLab review attempted a forbidden or cross-provider operation")]
        : [],
    scores: {
      routing_pass: routingPass,
      process_pass: processPass,
      outcome_pass: outcomePass,
      risk_pass: riskPass,
    },
  };
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(
    summary.summaryMdPath,
    `# context-tree-review Eval: ${summary.caseId}\n\n- passed: ${summary.passed}\n- expectedAction: ${summary.expectedAction}\n- reviewActions: ${summary.metrics.reviewEvents.map((item) => item.action).join(", ") || "none"}\n- verifyExitCodes: ${summary.metrics.verifyExitCodes.join(", ")}\n- verifyHeadBound: ${summary.metrics.verifyHeadBound}\n- successorDiffReviewed: ${summary.metrics.successorDiffReviewed}\n- checksCurrentHead: ${summary.metrics.checksCurrentHead}\n- finalViewFresh: ${summary.metrics.finalViewFresh}\n- blockedGithubAttempts: ${summary.metrics.blockedGithubAttempts}\n- mutationAttempted: ${summary.metrics.mutationAttempted}\n\n## Grading\n\n${gradingMarkdownRows(summary.grading)}\n`,
    "utf8",
  );
}

export function buildBatchSummary(cases: readonly CaseRunSummary[], runStartedAt: string): BatchSummary {
  const passed = cases.filter((item) => item.passed).length;
  return { cases, failed: cases.length - passed, passed, runStartedAt };
}

export function formatSummaryTable(batch: BatchSummary): string {
  return [
    "case_id\texpected\tactual\tpassed",
    ...batch.cases.map(
      (item) =>
        `${item.caseId}\t${item.expectedAction}\t${item.metrics.reviewEvents[0]?.action ?? "none"}\t${item.passed}`,
    ),
  ].join("\n");
}
