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
  const modelEventDir = join(workspacePath, ".first-tree-eval");
  const binDir = join(runRoot, "bin");
  const shellEnvDir = join(runRoot, "shell-env");

  rmSync(runRoot, { force: true, recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(modelEventDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(shellEnvDir, { recursive: true });

  return {
    binDir,
    eventsPath: join(runRoot, "events.jsonl"),
    gradingJsonPath: join(runRoot, "grading.json"),
    modelEventsPath: join(modelEventDir, "events.jsonl"),
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

export function writeShellPathBootstrap(paths: RunPaths, environment: Readonly<Record<string, string>> = {}): void {
  const environmentExports = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellSingleQuote(value)}\n`)
    .join("");
  const bootstrap = `export PATH=${shellSingleQuote(paths.binDir)}:\${PATH:-}\n${environmentExports}`;
  writeFileSync(join(paths.shellEnvDir, ".zshenv"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, ".zprofile"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, ".bash_profile"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, "bash-env"), bootstrap, "utf8");
  writeFileSync(join(paths.shellEnvDir, "sh-env"), bootstrap, "utf8");
}
