import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export type SubmittedReviewAction = "approve" | "comment" | "request-changes";
export type ReviewAction = "none" | SubmittedReviewAction;
export type ReviewScenario =
  | "archive-only"
  | "authority"
  | "draft"
  | "passing"
  | "semantic-failure"
  | "stale-head"
  | "submission-race"
  | "validator-failure";

export type ContextTreeReviewEvalCase = {
  briefingMode: "minimal";
  expected: { action: ReviewAction; bodyHints: readonly string[]; firstHeading?: string; verifyMustPass: boolean };
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
  bodyFilePath: string;
  bodyFileUsed: boolean;
  commitOid: string;
  currentHeadOid: string;
  eventIndex: number;
  prNumber: number;
  repo: string;
  runId: string;
};

export type ReviewFixtureExpectation = {
  agentId: string;
  baseOid: string;
  chatId: string;
  expectedFinalDraft: boolean;
  expectedFinalHeadOid: string;
  expectedFinalState: "OPEN";
  governedPaths: readonly string[];
  headRefName: string;
  headOid: string;
  prNumber: number;
  repo: string;
  reviewerLogin: string;
  runId: string;
  submissionHeadOid: string;
  workspacePath: string;
};

export type ReviewFixtureIntegrity = {
  mainHeadUnchanged: boolean;
  mainWorktreeClean: boolean;
  originRefsUnchanged: boolean;
  reviewBodyCleaned: boolean;
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

export type LocalMergeEvent = {
  commitOid: string;
  eventIndex: number;
  prNumber: number;
  repo: string;
};

export type EvalMetrics = {
  bodyHintsObserved: boolean;
  blockedGithubAttempts: number;
  expectedHeadingObserved: boolean;
  fetchHeadChecksCompletionOrdered: boolean;
  finalViewFresh: boolean;
  firstTreeReadLoaded: boolean;
  firstTreeVerifyCalls: number;
  fixtureIntegrity: ReviewFixtureIntegrity;
  ghReviewCalls: number;
  identityReadObserved: boolean;
  initialViewObserved: boolean;
  mainTreeReadAttempted: boolean;
  localMergeAttempts: number;
  localMergeValid: boolean;
  mutationAttempted: boolean;
  reviewAfterFinalView: boolean;
  reviewCommitBound: boolean;
  reviewEvents: readonly ReviewEvent[];
  runnerExitCode: number | null;
  runtimeIdentityChecksObserved: boolean;
  skillFileReadObserved: boolean;
  semanticReadAfterVerify: boolean;
  semanticReadAfterFailedVerify: boolean;
  semanticReadBeforeVerify: boolean;
  submissionRaceContained: boolean;
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
