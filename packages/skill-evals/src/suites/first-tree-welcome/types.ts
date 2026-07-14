import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type WelcomeRole = "admin" | "invitee";
export type WelcomeChatScenario = "onboarding" | "team-onboarding" | "tree-setup";
export type WelcomeRepoState = "none" | "local-readable" | "selected-readable" | "selected-auth-fails" | "unknown";
export type WelcomeTreeState = "none" | "empty" | "populated" | "unknown";
export type WelcomeGithubAppState = "installed" | "missing" | "unknown";
export type WelcomeTreeSetupChatState = "absent" | "exists" | "promised";

export type WelcomeExpectedAction =
  | "route_to_tree_skill"
  | "invitee_waits_for_team_readiness"
  | "ask_for_repo_path_or_url"
  | "report_auth_failure_without_claiming_repo_read"
  | "value_first_then_setup_handoff"
  | "confirm_ad_hoc_repo_after_value"
  | "offer_tree_build_with_code_value"
  | "offer_bounded_first_tasks_from_repo_and_tree"
  | "offer_repo_value_without_claiming_tree_ready"
  | "offer_invitee_value_without_admin_setup"
  | "give_evidence_value_or_ask_for_input";

export type FirstTreeWelcomeFixture = {
  githubAppState: WelcomeGithubAppState;
  chatScenario: WelcomeChatScenario;
  repoState: WelcomeRepoState;
  role: WelcomeRole;
  treeSetupChat: WelcomeTreeSetupChatState;
  treeState: WelcomeTreeState;
};

export type FirstTreeWelcomeExpected = {
  action: WelcomeExpectedAction;
  evidenceSnippets?: readonly string[];
  requiredResponseHints: readonly string[];
  taskOptionHints?: readonly string[];
};

export type FirstTreeWelcomeForbidden = {
  actions: readonly string[];
  claims: readonly string[];
  sideEffects: readonly string[];
};

export type FirstTreeWelcomeEvalCase = {
  briefingMode: "generated-fixture";
  expected: FirstTreeWelcomeExpected;
  fixture: FirstTreeWelcomeFixture;
  forbidden: FirstTreeWelcomeForbidden;
  id: string;
  prompt: string;
  provider: "codex";
  skill: "first-tree-welcome";
  status: "implemented" | "planned";
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
};

export type EvalMetrics = {
  chatAskCount: number;
  chatOptionCount: number | null;
  chatText: string;
  contextTreeChanged: boolean;
  contextTreeStatus: string;
  expectedEvidenceObserved: boolean;
  expectedResponseObserved: boolean;
  finalResponse: string;
  forbiddenActionHits: readonly string[];
  forbiddenClaimHits: readonly string[];
  forbiddenSideEffectHits: readonly string[];
  firstTreeArgv: readonly (readonly string[])[];
  fixtureValidationOk: boolean;
  repoConfirmationObserved: boolean;
  repoEvidenceReadObserved: boolean;
  repoRemoteReadObserved: boolean;
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  taskOptionsObserved: boolean;
  treeBuildOptionObserved: boolean;
  treeEvidenceReadObserved: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: WelcomeExpectedAction;
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
