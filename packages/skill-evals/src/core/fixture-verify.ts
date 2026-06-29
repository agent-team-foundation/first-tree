import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

import { appendEvent, previewText } from "./events.js";
import type { EvalReporter } from "./reporter.js";
import { stripShimTraceLines } from "./reporter.js";
import type { CommandResult, RunPaths } from "./types.js";

export const FIRST_TREE_EVAL_VERIFY_BIN = "FIRST_TREE_EVAL_VERIFY_BIN";
const FIRST_TREE_EVAL_REAL_FIRST_TREE = "FIRST_TREE_EVAL_REAL_FIRST_TREE";

type FixtureVerifyCommand = {
  command: string;
  source: "eval-real-first-tree" | "eval-verify-bin" | "harness-shim";
};

export type RunFixtureVerifyOptions = {
  caseId: string;
  contextTreePath: string;
  paths: RunPaths;
  reporter: EvalReporter;
  sourceEnv?: NodeJS.ProcessEnv;
  verbose: boolean;
};

export function runFixtureVerify(options: RunFixtureVerifyOptions): CommandResult {
  const { caseId, contextTreePath, paths, reporter, verbose } = options;
  const sourceEnv = options.sourceEnv ?? process.env;
  const args = ["tree", "verify", "--tree-path", contextTreePath];
  const verifyCommand = resolveFixtureVerifyCommand(paths, sourceEnv);

  appendEvent(paths.eventsPath, {
    command: verifyCommand.command,
    commandSource: verifyCommand.source,
    contextTreePath,
    type: "fixture_validation_started",
  });
  reporter.fixtureValidationStarted(args, contextTreePath);

  const result = spawnSync(verifyCommand.command, args, {
    cwd: paths.workspacePath,
    encoding: "utf8",
    env: fixtureVerifyEnv(paths, caseId, verbose, verifyCommand.source, sourceEnv),
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const rawStderr = result.stderr ?? "";
  const stderrWithSpawnError = result.error
    ? `${rawStderr}${rawStderr.length > 0 && !rawStderr.endsWith("\n") ? "\n" : ""}${result.error.message}`
    : rawStderr;
  reporter.shimTraceLines(stderrWithSpawnError);

  const commandResult: CommandResult = {
    args,
    command: verifyCommand.command,
    cwd: paths.workspacePath,
    exitCode: result.status ?? 1,
    stderr: stripShimTraceLines(stderrWithSpawnError),
    stdout,
  };

  appendEvent(paths.eventsPath, {
    command: commandResult.command,
    commandSource: verifyCommand.source,
    exitCode: commandResult.exitCode,
    stderrPreview: previewText(commandResult.stderr),
    stdoutPreview: previewText(commandResult.stdout),
    type: "fixture_validation_finished",
  });
  reporter.fixtureValidationFinished(commandResult);

  return commandResult;
}

function resolveFixtureVerifyCommand(paths: RunPaths, sourceEnv: NodeJS.ProcessEnv): FixtureVerifyCommand {
  const verifyBin = cleanEnvValue(sourceEnv[FIRST_TREE_EVAL_VERIFY_BIN]);
  if (verifyBin !== null) {
    return {
      command: verifyBin,
      source: "eval-verify-bin",
    };
  }

  const realFirstTree = cleanEnvValue(sourceEnv[FIRST_TREE_EVAL_REAL_FIRST_TREE]);
  if (realFirstTree !== null) {
    return {
      command: realFirstTree,
      source: "eval-real-first-tree",
    };
  }

  return {
    command: join(paths.binDir, "first-tree"),
    source: "harness-shim",
  };
}

function fixtureVerifyEnv(
  paths: RunPaths,
  caseId: string,
  verbose: boolean,
  commandSource: FixtureVerifyCommand["source"],
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const path = sourceEnv.PATH ?? "";
  return {
    ...sourceEnv,
    FIRST_TREE_EVAL_CASE_ID: caseId,
    FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
    FIRST_TREE_EVAL_PHASE: "fixture_validation",
    FIRST_TREE_EVAL_VERBOSE: verbose ? "1" : "0",
    PATH: commandSource === "harness-shim" ? prependPath(paths.binDir, path) : path,
  };
}

function cleanEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function prependPath(entry: string, path: string): string {
  return path ? `${entry}${delimiter}${path}` : entry;
}
