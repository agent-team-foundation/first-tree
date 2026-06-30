export type CommandResult = {
  args: readonly string[];
  command: string;
  cwd: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type RunPaths = {
  binDir: string;
  eventsPath: string;
  gradingJsonPath: string;
  modelEventsPath: string;
  packageRoot: string;
  repoRoot: string;
  runRoot: string;
  shellEnvDir: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  workspacePath: string;
};
