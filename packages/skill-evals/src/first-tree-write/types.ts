import type {
  BaseEvalMetrics,
  CliOptions,
  CommandResult,
  FixtureValidation,
  RunPaths,
  WorkspaceKind,
} from "../shared/types.js";

export type InstalledSkillSet = "write" | "read-write";

export type FirstTreeWriteEvalCase = {
  description: string;
  expectedTargetPath: string;
  expectedTrigger: boolean;
  id: string;
  installedSkillSet: InstalledSkillSet;
  prompt: string;
  promptAlternates: readonly string[];
  workspaceKind: WorkspaceKind;
};

export type { CliOptions, CommandResult, FixtureValidation, RunPaths, WorkspaceKind };

export type EvalMetrics = BaseEvalMetrics & {
  accidentalWriteHit: boolean;
  commandFailuresDuringModel: readonly {
    argv: readonly string[];
    exitCode: number;
  }[];
  contextSkillFileReadObserved: boolean;
  readSkillFileReadObserved: boolean;
  readSkillHit: boolean;
  targetMentionedInOutput: boolean;
  targetObservedAfterTreeListing: boolean;
  targetObservedInTreeListing: boolean;
  targetPathObserved: boolean;
  treeTreeCalls: number;
  treeTreeSucceeded: boolean;
  writeIntentInOutput: boolean;
  writeSkillFileReadObserved: boolean;
  writeSkillHit: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedTargetPath: string;
  expectedTrigger: boolean;
  fixtureValidation: FixtureValidation;
  installedSkillSet: InstalledSkillSet;
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
