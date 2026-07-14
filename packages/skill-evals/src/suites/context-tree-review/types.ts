import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export type SubmittedReviewAction = "approve" | "comment" | "request-changes";
export type ReviewAction = "none" | SubmittedReviewAction;
export type ReviewScenario =
  | "archive-only"
  | "authority"
  | "draft"
  | "passing"
  | "self-approval"
  | "semantic-failure"
  | "stale-head"
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
  bodyFileUsed: boolean;
  eventIndex: number;
  prNumber: number;
  repo: string;
};

export type ReviewFixtureExpectation = {
  baseOid: string;
  expectedFinalDraft: boolean;
  expectedFinalHeadOid: string;
  expectedFinalState: "OPEN";
  headOid: string;
  prNumber: number;
  repo: string;
};

export type ReviewFixtureIntegrity = {
  mainHeadUnchanged: boolean;
  mainWorktreeClean: boolean;
  originRefsUnchanged: boolean;
  reviewWorktreeCleaned: boolean;
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
  finalViewFresh: boolean;
  firstTreeVerifyCalls: number;
  fixtureIntegrity: ReviewFixtureIntegrity;
  ghReviewCalls: number;
  identityReadObserved: boolean;
  initialViewObserved: boolean;
  mutationAttempted: boolean;
  reviewAfterFinalView: boolean;
  reviewEvents: readonly ReviewEvent[];
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
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
