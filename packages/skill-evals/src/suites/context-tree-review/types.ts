import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export type SubmittedReviewAction = "approve" | "comment" | "request-changes";
export type ReviewAction = "none" | SubmittedReviewAction;
export type ReviewScenario =
  | "archive-only"
  | "authority"
  | "draft"
  | "merge-api-unsupported"
  | "merge-delivery-merged"
  | "merge-delivery-open"
  | "merge-delivery-unknown"
  | "merge-head-race"
  | "merge-queue-required"
  | "merge-response-provenance"
  | "passing"
  | "semantic-failure"
  | "validator-failure";
export type ExpectedMergeOutcome =
  | "api-unsupported"
  | "delivery-merged"
  | "delivery-open"
  | "delivery-unknown"
  | "head-mismatch"
  | "merged"
  | "not-attempted"
  | "queue-required";
export type MergeAttemptOutcome =
  | "api-unsupported"
  | "head-mismatch"
  | "queue-required"
  | "success"
  | "transport-merged"
  | "transport-open"
  | "transport-unknown";

export type ContextTreeReviewEvalCase = {
  briefingMode: "minimal";
  expected: {
    action: ReviewAction;
    bodyHints: readonly string[];
    firstHeading?: string;
    mergeOutcome: ExpectedMergeOutcome;
    verifyMustPass: boolean;
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
  reviewedHead: string;
  runId: string;
};

export type MergeEvent = {
  argv: readonly string[];
  currentHeadOid: string;
  eventIndex: number;
  exitCode: number;
  outcome: MergeAttemptOutcome;
  requestedHead: string;
};

export type MergeReconciliationEvent = {
  eventIndex: number;
  exitCode: number;
  headRefOid: string | null;
  merged: boolean | null;
  state: string | null;
};

export type ReviewFixtureExpectation = {
  baseOid: string;
  chatId: string;
  expectedFinalDraft: boolean;
  expectedFinalHeadOid: string;
  expectedFinalState: "OPEN";
  governedPaths: readonly string[];
  headOid: string;
  prNumber: number;
  repo: string;
  reviewerAgentUuid: string;
  runId: string;
  runtimeSessionToken: string;
  runtimeSessionTokenFile: string;
  workspacePath: string;
};

export type ReviewFixtureIntegrity = {
  mainHeadUnchanged: boolean;
  mainWorktreeClean: boolean;
  originRefsUnchanged: boolean;
  reviewWorktreeCleaned: boolean;
  treeConfigUnchanged: boolean;
  treeRefsUnchanged: boolean;
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
  bodyHintsObserved: boolean;
  blockedGithubAttempts: number;
  expectedHeadingObserved: boolean;
  finalResponse: string;
  finalViewFresh: boolean;
  firstTreeReadLoaded: boolean;
  firstTreeVerifyCalls: number;
  fixtureIntegrity: ReviewFixtureIntegrity;
  ghReviewCalls: number;
  identityReadObserved: boolean;
  initialViewObserved: boolean;
  mainTreeReadAttempted: boolean;
  mutationAttempted: boolean;
  mergeAfterApproval: boolean;
  mergeAttempts: readonly MergeEvent[];
  mergeContractExact: boolean;
  mergeHeadFromReviewResponse: boolean;
  mergeOutcomeObserved: ExpectedMergeOutcome;
  mergeReconciliations: readonly MergeReconciliationEvent[];
  mergeReportCorrect: boolean;
  mergeRetryAttempted: boolean;
  pullRequestMerged: boolean;
  reviewAfterFinalView: boolean;
  reviewCommitBound: boolean;
  reviewEvents: readonly ReviewEvent[];
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  semanticReadAfterVerify: boolean;
  semanticReadAfterFailedVerify: boolean;
  semanticReadBeforeVerify: boolean;
  targetMatches: boolean;
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
