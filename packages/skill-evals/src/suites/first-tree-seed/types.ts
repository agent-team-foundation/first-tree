import type { CommandResult } from "../../core/types.js";

export type SeedTreeState = "empty" | "nonempty";
export type SeedSourceRepoState = "bare-readable" | "missing";
export type SeedExpectedAction =
  | "propose_phase1_skeleton"
  | "refuse_nonempty_tree"
  | "report_missing_source"
  | "materialize_bare_worktree";

export type FirstTreeSeedFixture = {
  sourceRepoState: SeedSourceRepoState;
  treeState: SeedTreeState;
};

export type FirstTreeSeedExpected = {
  action: SeedExpectedAction;
  approvalHints?: readonly string[];
  requireSourceRead: boolean;
  requireWorktree: boolean;
  responseHints: readonly string[];
  skeletonHints?: readonly string[];
};

export type FirstTreeSeedForbidden = {
  actions: readonly string[];
  sideEffects: readonly string[];
};

export type FirstTreeSeedEvalCase = {
  briefingMode: "generated-fixture";
  expected: FirstTreeSeedExpected;
  fixture: FirstTreeSeedFixture;
  forbidden: FirstTreeSeedForbidden;
  id: string;
  prompt: string;
  provider: "codex";
  skill: "first-tree-seed";
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
  contextTreeVerifyResult: CommandResult | null;
  errors: readonly string[];
  ok: boolean;
  requiredFilesOk: boolean;
  sourceRepoOk: boolean;
  treeEmptyOk: boolean;
};

export type EvalMetrics = {
  approvalRequestObserved: boolean;
  contextTreeChanged: boolean;
  contextTreeStatus: string;
  directBareSourceContentReadObserved: boolean;
  expectedResponseObserved: boolean;
  finalResponse: string;
  firstTreeArgv: readonly (readonly string[])[];
  forbiddenActionHits: readonly string[];
  forbiddenSideEffectHits: readonly string[];
  fixtureValidationOk: boolean;
  phase2LeafContentObserved: boolean;
  runnerExitCode: number | null;
  seedSkillFileReadObserved: boolean;
  skeletonObserved: boolean;
  sourceEvidenceReadObserved: boolean;
  sourceRepoChanged: boolean;
  sourceWorktreeCreated: boolean;
  workspaceManifestReadObserved: boolean;
  writeSkillFileReadObserved: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: SeedExpectedAction;
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
