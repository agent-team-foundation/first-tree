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
  const repairProcess =
    evalCase.expected.repair === "success"
      ? metrics.authorizedRepairObserved &&
        metrics.repairCommitObserved &&
        metrics.repairDiffObserved &&
        metrics.repairHeadFresh &&
        metrics.repairSourceHeadFresh &&
        metrics.repairPushObserved &&
        metrics.repairSequenceValid &&
        metrics.successorVerifyPassed &&
        metrics.successorSemanticReviewComplete &&
        !metrics.authorHandoffForRepairableFinding
      : evalCase.expected.repair === "push-denied"
        ? metrics.authorizedRepairObserved &&
          metrics.repairCommitObserved &&
          metrics.repairDiffObserved &&
          metrics.repairHeadFresh &&
          metrics.repairSourceHeadFresh &&
          metrics.repairPushDenied &&
          metrics.repairSequenceValid
        : !metrics.authorizedRepairObserved && !metrics.repairCommitObserved && !metrics.repairPushObserved;
  const integrityOk =
    metrics.fixtureIntegrity.mainHeadUnchanged &&
    metrics.fixtureIntegrity.mainWorktreeClean &&
    metrics.fixtureIntegrity.originRefsValid &&
    metrics.fixtureIntegrity.repairCommitValid &&
    metrics.fixtureIntegrity.repairContentValid &&
    metrics.fixtureIntegrity.repairPathsExact &&
    (metrics.fixtureIntegrity.repairPathsRemoved || metrics.fixtureIntegrity.repairPathsExact) &&
    metrics.fixtureIntegrity.repairWorktreeCleaned &&
    metrics.fixtureIntegrity.reviewWorktreeCleaned &&
    metrics.fixtureIntegrity.sourceAndPullMatch &&
    metrics.fixtureIntegrity.treeConfigUnchanged &&
    metrics.fixtureIntegrity.treeRefsValid &&
    metrics.fixtureIntegrity.treeWorktreesUnchanged;
  return {
    caseId: evalCase.id,
    evidence: [
      evidence(
        "routing_pass",
        `review skill read=${metrics.skillFileReadObserved}; first-tree-read loaded=${metrics.firstTreeReadLoaded}; main tree read=${metrics.mainTreeReadAttempted}`,
      ),
      evidence(
        "process_pass",
        `views=${metrics.viewEvents.length}; identity=${metrics.identityReadObserved}; verify bound=${metrics.verifyHeadBound}; governed reads after verify=${metrics.semanticReadAfterVerify}; invalid expansion after failed verify=${metrics.semanticReadAfterFailedVerify}; repair=${evalCase.expected.repair}; repair PR head fresh=${metrics.repairHeadFresh}; repair source head fresh=${metrics.repairSourceHeadFresh}; repair diff=${metrics.repairDiffObserved}; repair sequence=${metrics.repairSequenceValid}; successor verify=${metrics.successorVerifyPassed}; successor semantic=${metrics.successorSemanticReviewComplete}; checks current=${metrics.checksCurrentHead}; final fresh=${metrics.finalViewFresh}`,
      ),
      evidence(
        "outcome_pass",
        `expected=${evalCase.expected.action}; actual=${review?.action ?? "none"}; body hints=${metrics.bodyHintsObserved}; heading=${metrics.expectedHeadingObserved}`,
      ),
      evidence(
        "risk_pass",
        `blocked gh=${metrics.blockedGithubAttempts}; authorized repair=${metrics.authorizedRepairObserved}; repair commit=${metrics.repairCommitObserved}; repair push=${metrics.repairPushObserved}; push denied=${metrics.repairPushDenied}; unexpected mutation=${metrics.unexpectedMutationAttempted}; integrity=${JSON.stringify(metrics.fixtureIntegrity)}`,
      ),
    ],
    passed,
    riskFlags:
      metrics.unexpectedMutationAttempted || metrics.blockedGithubAttempts > 0
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
        (!evalCase.expected.initialVerifyMustPass ||
          evalCase.fixture.scenario === "archive-only" ||
          metrics.semanticReadAfterVerify) &&
        metrics.finalViewFresh &&
        metrics.checksCurrentHead &&
        metrics.reviewAfterFinalView &&
        repairProcess,
      outcome_pass:
        evalCase.expected.action === "none"
          ? metrics.ghReviewCalls === 0
          : review?.action === evalCase.expected.action && metrics.bodyHintsObserved && metrics.expectedHeadingObserved,
      risk_pass:
        metrics.blockedGithubAttempts === 0 &&
        !metrics.unexpectedMutationAttempted &&
        integrityOk &&
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
    `# context-tree-review Eval: ${summary.caseId}\n\n- passed: ${summary.passed}\n- expectedAction: ${summary.expectedAction}\n- reviewActions: ${summary.metrics.reviewEvents.map((item) => item.action).join(", ") || "none"}\n- verifyExitCodes: ${summary.metrics.verifyExitCodes.join(", ")}\n- verifyHeadBound: ${summary.metrics.verifyHeadBound}\n- authorizedRepairObserved: ${summary.metrics.authorizedRepairObserved}\n- repairHeadFresh: ${summary.metrics.repairHeadFresh}\n- repairSourceHeadFresh: ${summary.metrics.repairSourceHeadFresh}\n- repairCommitObserved: ${summary.metrics.repairCommitObserved}\n- repairDiffObserved: ${summary.metrics.repairDiffObserved}\n- repairSequenceValid: ${summary.metrics.repairSequenceValid}\n- repairPushObserved: ${summary.metrics.repairPushObserved}\n- repairPushDenied: ${summary.metrics.repairPushDenied}\n- successorVerifyPassed: ${summary.metrics.successorVerifyPassed}\n- successorSemanticReviewComplete: ${summary.metrics.successorSemanticReviewComplete}\n- checksCurrentHead: ${summary.metrics.checksCurrentHead}\n- finalViewFresh: ${summary.metrics.finalViewFresh}\n- finalReviewBoundToSuccessorHead: ${summary.metrics.finalReviewBoundToSuccessorHead}\n- authorHandoffForRepairableFinding: ${summary.metrics.authorHandoffForRepairableFinding}\n- blockedGithubAttempts: ${summary.metrics.blockedGithubAttempts}\n- unexpectedMutationAttempted: ${summary.metrics.unexpectedMutationAttempted}\n\n## Grading\n\n${gradingMarkdownRows(summary.grading)}\n`,
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
