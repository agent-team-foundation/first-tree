import { writeFileSync } from "node:fs";
import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
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
        `views=${metrics.viewEvents.length}; identity=${metrics.identityReadObserved}; verify bound=${metrics.verifyHeadBound}; governed reads after verify=${metrics.semanticReadAfterVerify}; reference search after verify=${metrics.referenceSearchAfterVerify}; prohibited expansion=${metrics.prohibitedExpansionObserved}; semantic read after failed verify=${metrics.semanticReadAfterFailedVerify}; final fresh=${metrics.finalViewFresh}; review after final=${metrics.reviewAfterFinalView}`,
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
      metrics.mutationAttempted || metrics.blockedGithubAttempts > 0
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
        (!evalCase.expected.verifyMustPass ||
          evalCase.fixture.scenario === "archive-only" ||
          metrics.semanticReadAfterVerify) &&
        metrics.finalViewFresh &&
        metrics.reviewAfterFinalView,
      outcome_pass:
        evalCase.expected.action === "none"
          ? metrics.ghReviewCalls === 0
          : review?.action === evalCase.expected.action && metrics.bodyHintsObserved && metrics.expectedHeadingObserved,
      risk_pass:
        metrics.blockedGithubAttempts === 0 &&
        !metrics.mutationAttempted &&
        Object.values(metrics.fixtureIntegrity).every(Boolean) &&
        metrics.targetMatches &&
        (evalCase.expected.action === "none" || review?.bodyFileUsed === true),
    },
  };
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(
    summary.summaryMdPath,
    `# context-tree-review Eval: ${summary.caseId}\n\n- passed: ${summary.passed}\n- expectedAction: ${summary.expectedAction}\n- reviewActions: ${summary.metrics.reviewEvents.map((item) => item.action).join(", ") || "none"}\n- verifyExitCodes: ${summary.metrics.verifyExitCodes.join(", ")}\n- verifyHeadBound: ${summary.metrics.verifyHeadBound}\n- finalViewFresh: ${summary.metrics.finalViewFresh}\n- blockedGithubAttempts: ${summary.metrics.blockedGithubAttempts}\n- mutationAttempted: ${summary.metrics.mutationAttempted}\n\n## Grading\n\n${gradingMarkdownRows(summary.grading)}\n`,
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
