export type WorkspaceKind = "blank" | "context-tree";

export type SkillEvalCaseBase = {
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
  shellEnvDir: string;
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

export type CommandSummary = {
  argv: readonly string[];
  exitCode: number;
  stderrPreview?: string;
  stdoutPreview?: string;
};

export type BaseEvalMetrics = {
  firstTreeArgv: readonly (readonly string[])[];
  firstTreeCalls: number;
  firstTreeCommandResults: readonly CommandSummary[];
  fixtureValidationOk: boolean;
  modelFirstTreeCommandsOk: boolean;
  runnerExitCode: number | null;
};
