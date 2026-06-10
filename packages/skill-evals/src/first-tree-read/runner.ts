import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { appendEvent, previewText, readEvents } from "./events.js";
import { createFirstTreeShim, createRunPaths, setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics, fixtureOnlyPassed } from "./metrics.js";
import type { EvalReporter } from "./reporter.js";
import { createEvalReporter, isShimTraceLine } from "./reporter.js";
import { driftNote, writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeReadEvalCase, RunPaths } from "./types.js";

function codexArgs(options: CliOptions, workspacePath: string, prompt: string): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--cd",
    workspacePath,
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "shell_environment_policy.inherit=all",
  ];

  if (options.model !== null) {
    args.push("--model", options.model);
  }

  args.push(prompt);
  return args;
}

async function consumeCodexStdout(
  eventsPath: string,
  stream: NodeJS.ReadableStream,
  reporter: EvalReporter,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      appendEvent(eventsPath, {
        event,
        type: "codex_event",
      });
      reporter.codexEvent(event);
    } catch {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stdout",
      });
      reporter.codexStdoutLine(line);
    }
  }
}

async function consumeStderr(eventsPath: string, stream: NodeJS.ReadableStream, reporter: EvalReporter): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!isShimTraceLine(line)) {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stderr",
      });
    }
    reporter.codexStderrLine(line);
  }
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  eventsPath: string,
  reporter: EvalReporter,
): Promise<number> {
  return await new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      appendEvent(eventsPath, {
        error: error.message,
        type: "codex_spawn_error",
      });
      reporter.codexSpawnError(error);
      resolve(127);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      appendEvent(eventsPath, {
        exitCode: code ?? 1,
        signal,
        type: "codex_process_closed",
      });
      reporter.codexProcessFinished(code ?? 1);
      resolve(code ?? 1);
    });
  });
}

async function runCodex(
  options: CliOptions,
  evalCase: FirstTreeReadEvalCase,
  paths: RunPaths,
  reporter: EvalReporter,
): Promise<number> {
  const args = codexArgs(options, paths.workspacePath, evalCase.prompt);
  appendEvent(paths.eventsPath, {
    args,
    caseId: evalCase.id,
    type: "codex_run_started",
  });
  reporter.codexProcessStarted(args);

  const env = {
    ...process.env,
    FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
    FIRST_TREE_EVAL_CASE_ID: evalCase.id,
    FIRST_TREE_EVAL_PHASE: "model",
    FIRST_TREE_EVAL_VERBOSE: options.verbose ? "1" : "0",
    BASH_ENV: join(paths.shellEnvDir, "bash-env"),
    ENV: join(paths.shellEnvDir, "sh-env"),
    PATH: `${paths.binDir}:${process.env.PATH ?? ""}`,
    ZDOTDIR: paths.shellEnvDir,
  };

  const child = spawn(options.codexBin, args, {
    cwd: paths.workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  const streamTasks: Promise<void>[] = [];
  if (stdout) streamTasks.push(consumeCodexStdout(paths.eventsPath, stdout, reporter));
  if (stderr) streamTasks.push(consumeStderr(paths.eventsPath, stderr, reporter));

  const exitCode = await waitForChildExit(child, paths.eventsPath, reporter);
  await Promise.all(streamTasks);

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    exitCode,
    type: "codex_run_finished",
  });

  return exitCode;
}

export async function runFirstTreeReadCase(
  packageRoot: string,
  evalCase: FirstTreeReadEvalCase,
  options: CliOptions,
  runStartedAt: string,
): Promise<CaseRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = createRunPaths(packageRoot, evalCase, startedAt);
  const reporter = createEvalReporter(evalCase.id, options.verbose);
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    runStartedAt,
    type: "case_started",
  });
  reporter.caseStarted();

  createFirstTreeShim(paths);
  const contextTreePath = setupFixture(evalCase, paths, reporter);
  const fixtureValidation = validateFixture(paths, contextTreePath, evalCase.id, options.verbose, reporter);
  const runnerExitCode = options.validateFixtures ? 0 : await runCodex(options, evalCase, paths, reporter);
  const metrics = deriveMetrics(
    readEvents(paths.eventsPath),
    fixtureValidation,
    runnerExitCode,
    evalCase.expectedFacts,
  );
  const passed = options.validateFixtures
    ? fixtureOnlyPassed(fixtureValidation)
    : casePassed(evalCase.expectedTrigger, metrics);

  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(metrics, evalCase.expectedTrigger),
    expectedTrigger: evalCase.expectedTrigger,
    fixtureValidation,
    metrics,
    passed,
    prompt: evalCase.prompt,
    runRoot: paths.runRoot,
    startedAt,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    workspacePath: paths.workspacePath,
  };

  writeCaseSummaries(summary);
  reporter.summaryWritten(paths.summaryJsonPath, paths.summaryMdPath);
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    passed,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    type: "case_finished",
  });
  reporter.caseFinished(passed);

  return summary;
}
