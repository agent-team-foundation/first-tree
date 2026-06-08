import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { appendEvent, previewText, readEvents } from "./events.js";
import { createFirstTreeDevShim, createRunPaths, setupFixture, validateFixture } from "./fixture.js";
import { casePassed, deriveMetrics, fixtureOnlyPassed } from "./metrics.js";
import { driftNote, writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, FirstTreeReadEvalCase } from "./types.js";

function codexArgs(options: CliOptions, workspacePath: string, prompt: string): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--cd",
    workspacePath,
    "--sandbox",
    "danger-full-access",
    "--ask-for-approval",
    "never",
    "-c",
    "shell_environment_policy.inherit=all",
  ];

  if (options.model !== null) {
    args.push("--model", options.model);
  }

  args.push(prompt);
  return args;
}

async function consumeCodexStdout(eventsPath: string, stream: NodeJS.ReadableStream): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      appendEvent(eventsPath, {
        event: JSON.parse(line),
        type: "codex_event",
      });
    } catch {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stdout",
      });
    }
  }
}

async function consumeStderr(eventsPath: string, stream: NodeJS.ReadableStream): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    appendEvent(eventsPath, {
      linePreview: previewText(line),
      type: "codex_stderr",
    });
  }
}

async function waitForChildExit(child: ReturnType<typeof spawn>, eventsPath: string): Promise<number> {
  return await new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      appendEvent(eventsPath, {
        error: error.message,
        type: "codex_spawn_error",
      });
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
      resolve(code ?? 1);
    });
  });
}

async function runCodex(
  options: CliOptions,
  evalCase: FirstTreeReadEvalCase,
  workspacePath: string,
  eventsPath: string,
): Promise<number> {
  const args = codexArgs(options, workspacePath, evalCase.prompt);
  appendEvent(eventsPath, {
    args,
    caseId: evalCase.id,
    type: "codex_run_started",
  });

  const env = {
    ...process.env,
    FIRST_TREE_EVAL_EVENTS: eventsPath,
    FIRST_TREE_EVAL_PHASE: "model",
    PATH: `${join(dirname(workspacePath), "bin")}:${process.env.PATH ?? ""}`,
  };

  const child = spawn(options.codexBin, args, {
    cwd: workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  const streamTasks: Promise<void>[] = [];
  if (stdout) streamTasks.push(consumeCodexStdout(eventsPath, stdout));
  if (stderr) streamTasks.push(consumeStderr(eventsPath, stderr));

  const exitCode = await waitForChildExit(child, eventsPath);
  await Promise.all(streamTasks);

  appendEvent(eventsPath, {
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
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    runStartedAt,
    type: "case_started",
  });

  createFirstTreeDevShim(paths);
  const contextTreePath = setupFixture(evalCase, paths);
  const fixtureValidation = validateFixture(paths, contextTreePath);
  const runnerExitCode = options.validateFixtures
    ? 0
    : await runCodex(options, evalCase, paths.workspacePath, paths.eventsPath);
  const metrics = deriveMetrics(readEvents(paths.eventsPath), fixtureValidation, runnerExitCode);
  const passed = options.validateFixtures
    ? fixtureOnlyPassed(fixtureValidation)
    : casePassed(evalCase.expectedTrigger, metrics);

  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    driftNote: driftNote(metrics),
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
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    passed,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    type: "case_finished",
  });

  return summary;
}
