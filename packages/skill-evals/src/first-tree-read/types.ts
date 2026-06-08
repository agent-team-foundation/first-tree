export type WorkspaceKind = "blank" | "context-tree";

export type FirstTreeReadEvalCase = {
  description: string;
  expectedTrigger: boolean;
  id: string;
  prompt: string;
  promptAlternates: readonly string[];
  workspaceKind: WorkspaceKind;
};

export type RunPaths = {
  binDir: string;
  eventsPath: string;
  packageRoot: string;
  repoRoot: string;
  runRoot: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  workspacePath: string;
};

export type CommandResult = {
  args: readonly string[];
  command: string;
  cwd: string;
  exitCode: number;
  stderr: string;
  stdout: string;
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
  codexBin: string;
  json: boolean;
  model: string | null;
  validateFixtures: boolean;
  verbose: boolean;
};

export type EvalMetrics = {
  firstTreeDevArgv: readonly (readonly string[])[];
  firstTreeDevCalls: number;
  fixtureValidationOk: boolean;
  helpAttempted: boolean;
  helpCalls: number;
  helpExitCodes: readonly number[];
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  skillHit: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedTrigger: boolean;
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
