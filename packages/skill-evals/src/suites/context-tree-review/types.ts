import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export type SubmittedReviewAction = "approve" | "comment" | "request-changes";
export type ReviewAction = "none" | SubmittedReviewAction;
export type RepairExpectation = "none" | "push-denied" | "success";
export type ReviewScenario =
  | "archive-only"
  | "authority"
  | "draft"
  | "mixed-repair-authority"
  | "passing"
  | "push-denied"
  | "relationship-change"
  | "semantic-failure"
  | "validator-failure";

export type ContextTreeReviewEvalCase = {
  briefingMode: "minimal";
  expected: {
    action: ReviewAction;
    bodyHints: readonly string[];
    firstHeading?: string;
    initialVerifyMustPass: boolean;
    repair: RepairExpectation;
    repairPaths: readonly string[];
    repairableHandoffHints?: readonly string[];
  };
  fixture: { scenario: ReviewScenario };
  id: string;
  prompt: string;
  provider: "codex";
  skill: "context-tree-review";
  status: "implemented";
  tags: readonly string[];
  tier: "gate";
};

export type CliOptions = {
  caseId: string | null;
  claudeBin: string;
  codexBin: string;
  json: boolean;
  model: string | null;
  provider: AgentProviderName;
  verbose: boolean;
};

export type ReviewEvent = {
  action: SubmittedReviewAction;
  body: string;
  bodyFileUsed: boolean;
  commitOid: string;
  currentHeadOid: string;
  eventIndex: number;
  prNumber: number;
  repo: string;
  runId: string;
};

export type ReviewFixtureExpectation = {
  baseOid: string;
  chatId: string;
  expectedFinalDraft: boolean;
  expectedFinalState: "OPEN";
  forbiddenPaths: readonly string[];
  governedPaths: readonly string[];
  headOid: string;
  initialVerifyMustPass: boolean;
  prNumber: number;
  repair: RepairExpectation;
  repairPaths: readonly string[];
  repairWorktreePath: string;
  repo: string;
  reviewerAgentUuid: string;
  runId: string;
  runtimeSessionToken: string;
  runtimeSessionTokenFile: string;
  sourceBranch: string;
  requiredReferenceSearches: readonly string[];
  submissionHeadOid: string;
  workspacePath: string;
};

export type ReviewFixtureIntegrity = {
  finalDiffEmpty: boolean;
  finalHeadOid: string;
  mainHeadUnchanged: boolean;
  mainWorktreeClean: boolean;
  originRefsValid: boolean;
  repairCommitValid: boolean;
  repairContentValid: boolean;
  repairPathsExact: boolean;
  repairPathsRemoved: boolean;
  repairWorktreeCleaned: boolean;
  reviewWorktreeCleaned: boolean;
  sourceAndPullMatch: boolean;
  sourceHeadOid: string;
  treeConfigUnchanged: boolean;
  treeRefsValid: boolean;
  treeWorktreesUnchanged: boolean;
};

export type ViewEvent = {
  eventIndex: number;
  headRefOid: string;
  isDraft: boolean;
  prNumber: number;
  repo: string;
  state: string;
};

export type EvalMetrics = {
  authorHandoffForRepairableFinding: boolean;
  bodyHintsObserved: boolean;
  blockedGithubAttempts: number;
  checksCurrentHead: boolean;
  expectedHeadingObserved: boolean;
  finalViewFresh: boolean;
  firstTreeReadLoaded: boolean;
  firstTreeVerifyCalls: number;
  fixtureIntegrity: ReviewFixtureIntegrity;
  ghReviewCalls: number;
  identityReadObserved: boolean;
  initialViewObserved: boolean;
  mainTreeReadAttempted: boolean;
  repairPushDenied: boolean;
  mutationAttempted: boolean;
  prohibitedExpansionObserved: boolean;
  referenceSearchAfterVerify: boolean;
  reviewAfterFinalView: boolean;
  reviewCommitBound: boolean;
  reviewEvents: readonly ReviewEvent[];
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  semanticReadAfterVerify: boolean;
  semanticReadAfterFailedVerify: boolean;
  semanticReadBeforeVerify: boolean;
  successorDiffReviewed: boolean;
  successorSemanticReviewComplete: boolean;
  successorVerifyPassed: boolean;
  targetMatches: boolean;
  finalReviewBoundToSuccessorHead: boolean;
  verifyExitCodes: readonly number[];
  verifyFirst: boolean;
  verifyHeadBound: boolean;
  viewEvents: readonly ViewEvent[];
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: ReviewAction;
  firstResponseLatencyMs: number | null;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  turns: number | null;
  workspacePath: string;
};

export type BatchSummary = {
  cases: readonly CaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
