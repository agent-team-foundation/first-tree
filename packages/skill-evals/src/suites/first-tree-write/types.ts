import type { CommandResult } from "../../core/types.js";

export type SourceArtifactKind = "absent" | "durable-decision-note" | "implementation-only-diff";
export type TreeState = "populated";
export type TreeDiffExpectation = "none" | "minimal";
export type ExpectedAction = "refuse_without_source" | "write_minimal_tree_diff" | "refuse_implementation_only_source";

export type FirstTreeWriteFixture = {
  sourceArtifact: SourceArtifactKind;
  treeState: TreeState;
};

export type FirstTreeWriteExpected = {
  action: ExpectedAction;
  requiredDiffSnippets?: readonly string[];
  requireVerify: boolean;
  responseHints: readonly string[];
  treeDiff: TreeDiffExpectation;
};

export type FirstTreeWriteForbidden = {
  content: readonly string[];
  sideEffects: readonly string[];
};

export type FirstTreeWriteEvalCase = {
  briefingMode: "minimal";
  expected: FirstTreeWriteExpected;
  fixture: FirstTreeWriteFixture;
  forbidden: FirstTreeWriteForbidden;
  id: string;
  prompt: string;
  provider: "codex";
  skill: "first-tree-write";
  status: "implemented";
  tags: readonly string[];
  tier: "gate";
};

export type CliOptions = {
  caseId: string | null;
  codexBin: string;
  json: boolean;
  model: string | null;
  verbose: boolean;
};

export type FixtureValidation = {
  errors: readonly string[];
  ok: boolean;
  requiredFilesOk: boolean;
  verifyResult: CommandResult;
};

export type TreeStateSnapshot = {
  diff: string;
  status: string;
};

export type EvalMetrics = {
  expectedDiffSnippetsObserved: boolean;
  expectedResponseObserved: boolean;
  finalResponse: string;
  firstTreeArgv: readonly (readonly string[])[];
  firstTreeCommandResults: readonly {
    argv: readonly string[];
    exitCode: number;
  }[];
  fixtureValidationOk: boolean;
  forbiddenContentHits: readonly string[];
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  treeChanged: boolean;
  treeDiff: string;
  treeStatus: string;
  verifySucceeded: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: ExpectedAction;
  fixtureValidation: FixtureValidation;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  workspacePath: string;
};

export type BatchSummary = {
  cases: readonly CaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
