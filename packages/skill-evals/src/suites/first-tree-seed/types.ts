import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type SeedTreeState = "empty" | "nonempty" | "phase1-approved" | "unbound";
export type SeedSourceRepoState = "bare-readable" | "chat-local-readable" | "missing" | "real-first-tree-bare-readable";
export type SeedChatHistoryState = "absent" | "approved-phase1";
export type SeedSourceForge = "github" | "gitlab";
export type SeedSourceLocalBranchState = "fresh" | "stale";
export type SeedExpectedAction =
  | "propose_phase1_skeleton"
  | "refuse_nonempty_tree"
  | "report_missing_source"
  | "materialize_bare_worktree"
  | "create_tree_via_init"
  | "continue_phase2";

export type FirstTreeSeedFixture = {
  chatHistoryState?: SeedChatHistoryState;
  sourceDeclaredRef?: string;
  sourceDefaultBranch?: string;
  sourceForge?: SeedSourceForge;
  sourceLocalBranchState?: SeedSourceLocalBranchState;
  sourceRepoState: SeedSourceRepoState;
  treeState: SeedTreeState;
};

export type FirstTreeSeedExpected = {
  action: SeedExpectedAction;
  approvalHints?: readonly string[];
  requireChatHistoryRead?: boolean;
  requireGithubGovernanceBootstrap?: boolean;
  requireGithubGovernanceRecovery?: boolean;
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
  tier: "gate" | "periodic";
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
  chatHistoryReadObserved: boolean;
  contextTreeChanged: boolean;
  contextTreeStatus: string;
  directBareSourceContentReadObserved: boolean;
  expectedResponseObserved: boolean;
  finalResponse: string;
  firstTreeArgv: readonly (readonly string[])[];
  forbiddenActionHits: readonly string[];
  forbiddenSideEffectHits: readonly string[];
  fixtureValidationOk: boolean;
  githubGovernanceBootstrapObserved: boolean;
  githubGovernanceRecoveryObserved: boolean;
  githubAppRequirementObserved: boolean;
  phase2ContinuationObserved: boolean;
  phase2LeafContentObserved: boolean;
  phase2RefusalObserved: boolean;
  runnerExitCode: number | null;
  seedSkillFileReadObserved: boolean;
  skeletonObserved: boolean;
  sourceEvidenceReadObserved: boolean;
  sourceRepoChanged: boolean;
  // Event-level signal that the model touched a `worktrees/seed-source-repo`
  // path (materialize or read). Unlike `sourceWorktreeCreated` (final
  // filesystem state), this survives a `git worktree remove` before grading, so
  // a Phase-1 add/read/cleanup sequence cannot erase it.
  sourceWorktreeAccessObserved: boolean;
  sourceWorktreeCreated: boolean;
  sourceWorktreeMaterializedObserved: boolean;
  treeInitObserved: boolean;
  treeInitWithContextTreeDirObserved: boolean;
  workspaceManifestReadObserved: boolean;
  writeSkillFileReadObserved: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: SeedExpectedAction;
  firstResponseLatencyMs: number | null;
  fixtureValidation: FixtureValidation;
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
