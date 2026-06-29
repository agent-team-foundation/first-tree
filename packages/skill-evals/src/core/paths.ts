import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RunPaths } from "./types.js";

export type CreateRunPathsOptions = {
  caseId: string;
  packageRoot: string;
  startedAt: string;
};

export function createRunPaths(options: CreateRunPathsOptions): RunPaths {
  const repoRoot = dirname(dirname(options.packageRoot));
  const stamp = options.startedAt.replace(/[-:.]/gu, "");
  const runRoot = join(options.packageRoot, ".runs", `${stamp}-${options.caseId}`);
  const workspacePath = join(runRoot, "workspace");
  const binDir = join(runRoot, "bin");
  const shellEnvDir = join(runRoot, "shell-env");

  rmSync(runRoot, { force: true, recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(shellEnvDir, { recursive: true });

  return {
    binDir,
    eventsPath: join(runRoot, "events.jsonl"),
    gradingJsonPath: join(runRoot, "grading.json"),
    packageRoot: options.packageRoot,
    repoRoot,
    runRoot,
    shellEnvDir,
    summaryJsonPath: join(runRoot, "summary.json"),
    summaryMdPath: join(runRoot, "summary.md"),
    workspacePath,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function writeShellPathBootstrap(paths: RunPaths): void {
  const bootstrap = `export PATH=${shellSingleQuote(paths.binDir)}:\${PATH:-}\n`;
  writeFileSync(join(paths.shellEnvDir, ".zshenv"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, ".zprofile"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, ".bash_profile"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, "bash-env"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, "sh-env"), bootstrap, "utf8");
}
