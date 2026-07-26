import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export const QA_SURFACES = ["cli", "web"] as const;
export const QA_CAPABILITIES = ["build", "run", "drive", "observe", "measure", "reset"] as const;

export type QaSurface = (typeof QA_SURFACES)[number];
export type QaCapability = (typeof QA_CAPABILITIES)[number];
export type QaFixtureMode = "readiness-blocked" | "ready";
export type QaExpectedStatus = "BLOCKED" | "PASS";

export type FirstTreeQaEvalCase = {
  briefingMode: "generated-fixture";
  expected: {
    disposition: "no-change";
    planShouldExist: boolean;
    status: QaExpectedStatus;
    taskShouldRun: boolean;
  };
  fixture: {
    mode: QaFixtureMode;
  };
  id: string;
  prompt: string;
  provider: "codex";
  skill: "first-tree-qa";
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

export type FixtureValidation = {
  errors: readonly string[];
  ok: boolean;
  requiredFilesOk: boolean;
};

export type ProductEvent = {
  at: number;
  capability?: QaCapability;
  kind: "capability_failed" | "capability_ok" | "task_ok";
  surface: QaSurface;
  task?: string;
};

export type EvalMetrics = {
  attemptedCapabilities: readonly string[];
  dispositionObserved: boolean;
  evidenceObserved: boolean;
  expectedStatusObserved: boolean;
  failedCapabilities: readonly string[];
  finalResponse: string;
  fixtureValidationOk: boolean;
  performanceObserved: boolean;
  planAfterReadiness: boolean;
  planExists: boolean;
  productEvidenceObserved: boolean;
  readinessComplete: boolean;
  reportExists: boolean;
  reportText: string;
  runContextExists: boolean;
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  successfulCapabilities: readonly string[];
  taskAfterPlan: boolean;
  taskRan: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: QaExpectedStatus;
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
