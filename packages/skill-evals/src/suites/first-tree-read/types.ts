import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type WorkspaceKind = "blank" | "byo-context-tree" | "context-tree";
export type BriefingMode = "minimal" | "runtime-generated";
export type ReadMode = "byo" | "managed";

export type FirstTreeReadEvalCase = {
  briefingMode?: BriefingMode;
  description: string;
  expectedFacts: readonly string[];
  expectedTrigger: boolean;
  id: string;
  prompt: string;
  promptAlternates: readonly string[];
  readMode: ReadMode;
  workspaceKind: WorkspaceKind;
};

export type FixtureValidation = {
  domainNodeCount: number;
  errors: readonly string[];
  minDepthOk: boolean;
  ok: boolean;
  requiredFilesOk: boolean;
  verifyResult: CommandResult | null;
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

export type EvalMetrics = {
  expectedFactHits: readonly string[];
  expectedFactsObserved: boolean;
  firstTreeArgv: readonly (readonly string[])[];
  firstTreeCalls: number;
  firstTreeCommandResults: readonly {
    argv: readonly string[];
    exitCode: number;
  }[];
  fixtureValidationOk: boolean;
  helpAttempted: boolean;
  helpCalls: number;
  helpExitCodes: readonly number[];
  helpSucceeded: boolean;
  byoReadSequenceOk: boolean;
  byoSelectorsNoPull: boolean;
  byoSnapshotDetached: boolean;
  byoSnapshotExactHeadConsistent: boolean;
  modelFirstTreeCommandsOk: boolean;
  readActivationCalls: number;
  readActivationSucceeded: boolean;
  readHelpSucceeded: boolean;
  runnerExitCode: number | null;
  selectionSucceeded: boolean;
  skillFileReadObserved: boolean;
  skillHit: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedTrigger: boolean;
  firstResponseLatencyMs: number | null;
  fixtureValidation: FixtureValidation;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  readMode: ReadMode;
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
