import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export type AuditScenario =
  | "decision-lock"
  | "mechanical"
  | "no-binding"
  | "report-only"
  | "stale-before-write"
  | "stale-before-publish"
  | "strong-local"
  | "weak-cross-domain";

export type AuditExpectedAction = "fail-closed" | "focused-pr" | "human-ask" | "issue-or-ask" | "report";

export type ContextTreeAuditEvalCase = {
  briefingMode: "minimal";
  expected: {
    action: AuditExpectedAction;
    diffPaths: readonly string[];
    verifyExitCode: number | null;
    writeSkillRequired: boolean;
  };
  fixture: { mode: "maintenance" | "report-only"; scenario: AuditScenario };
  id: string;
  prompt: string;
  provider: "codex";
  skill: "context-tree-audit";
  status: "implemented";
  tags: readonly string[];
  tier: "gate";
};

export type AuditFixtureExpectation = {
  advancedHeadOid: string | null;
  auditWorktreePath: string | null;
  defaultBranch: "main";
  expectedAction: AuditExpectedAction;
  expectedDiffPaths: readonly string[];
  expectedFinding: {
    claimTokens: readonly string[];
    evidenceTokens: readonly string[];
    policyTokens: readonly string[];
  } | null;
  headOid: string | null;
  mode: "maintenance" | "report-only";
  originPath: string | null;
  repo: string;
  scenario: AuditScenario;
  scope: string;
  workspacePath: string;
};

export type AuditFixtureIntegrity = {
  auditWorktreeCleaned: boolean;
  mainHeadUnchanged: boolean;
  mainWorktreeClean: boolean;
  noGuessedTreeState: boolean;
  originMainExpected: boolean;
  unpublishedAuthoringStateClean: boolean;
};

export type AuditFixtureState = AuditFixtureIntegrity & {
  changedBranchCount: number;
  diffPaths: readonly string[];
  expectedContentObserved: boolean;
};

export type AuditArtifact = "human-ask" | "issue" | "pull-request";

export type AuditEvalMetrics = {
  artifactCount: number;
  artifacts: readonly AuditArtifact[];
  blockedExternalAttempts: number;
  expectedActionObserved: boolean;
  evidenceOrderValid: boolean;
  artifactPayloadsValid: boolean;
  firstTreeReadLoaded: boolean;
  fixtureState: AuditFixtureState;
  helpObserved: boolean;
  runnerExitCode: number | null;
  selectorObserved: boolean;
  selectorBoundToSnapshot: boolean;
  semanticReadAfterVerify: boolean;
  semanticReadBeforeVerify: boolean;
  selfReviewOrMergeAttempted: boolean;
  skillFileReadObserved: boolean;
  siblingEvidenceReadObserved: boolean;
  sourceEvidenceReadObserved: boolean;
  verifyBoundToSnapshot: boolean;
  verifyExitCodes: readonly number[];
  writeSkillReadObserved: boolean;
  writeFreshnessChecked: boolean;
  publicationFreshnessChecked: boolean;
  draftPullRequestObserved: boolean;
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

export type AuditCaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: AuditExpectedAction;
  firstResponseLatencyMs: number | null;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: AuditEvalMetrics;
  passed: boolean;
  prompt: string;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  turns: number | null;
  workspacePath: string;
};

export type AuditBatchSummary = {
  cases: readonly AuditCaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
