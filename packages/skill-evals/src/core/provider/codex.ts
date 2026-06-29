import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { appendEvent, previewText } from "../events.js";
import { isShimTraceLine } from "../reporter.js";
import type { ProviderRunContext, ProviderRunOptions } from "./types.js";

function codexArgs(options: ProviderRunOptions, workspacePath: string): string[] {
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

  args.push(options.prompt);
  return args;
}

async function consumeCodexStdout(
  eventsPath: string,
  stream: NodeJS.ReadableStream,
  context: ProviderRunContext,
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
      context.reporter.codexEvent(event);
    } catch {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stdout",
      });
      context.reporter.codexStdoutLine(line);
    }
  }
}

async function consumeStderr(
  eventsPath: string,
  stream: NodeJS.ReadableStream,
  context: ProviderRunContext,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!isShimTraceLine(line)) {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "codex_stderr",
      });
    }
    context.reporter.codexStderrLine(line);
  }
}

async function waitForChildExit(child: ReturnType<typeof spawn>, context: ProviderRunContext): Promise<number> {
  return await new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      appendEvent(context.paths.eventsPath, {
        error: error.message,
        type: "codex_spawn_error",
      });
      context.reporter.codexSpawnError(error);
      resolve(127);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      appendEvent(context.paths.eventsPath, {
        exitCode: code ?? 1,
        signal,
        type: "codex_process_closed",
      });
      context.reporter.codexProcessFinished(code ?? 1);
      resolve(code ?? 1);
    });
  });
}

export async function runCodexProvider(options: ProviderRunOptions, context: ProviderRunContext): Promise<number> {
  const args = codexArgs(options, context.paths.workspacePath);
  appendEvent(context.paths.eventsPath, {
    args,
    caseId: options.caseId,
    type: "codex_run_started",
  });
  context.reporter.codexProcessStarted(args);

  const env = {
    ...process.env,
    FIRST_TREE_EVAL_EVENTS: context.paths.eventsPath,
    FIRST_TREE_EVAL_CASE_ID: options.caseId,
    FIRST_TREE_EVAL_PHASE: "model",
    FIRST_TREE_EVAL_VERBOSE: options.verbose ? "1" : "0",
    BASH_ENV: join(context.paths.shellEnvDir, "bash-env"),
    ENV: join(context.paths.shellEnvDir, "sh-env"),
    PATH: `${context.paths.binDir}:${process.env.PATH ?? ""}`,
    ZDOTDIR: context.paths.shellEnvDir,
  };

  const child = spawn(options.bin, args, {
    cwd: context.paths.workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const streamTasks: Promise<void>[] = [];
  if (child.stdout) streamTasks.push(consumeCodexStdout(context.paths.eventsPath, child.stdout, context));
  if (child.stderr) streamTasks.push(consumeStderr(context.paths.eventsPath, child.stderr, context));

  const exitCode = await waitForChildExit(child, context);
  await Promise.all(streamTasks);

  appendEvent(context.paths.eventsPath, {
    caseId: options.caseId,
    exitCode,
    type: "codex_run_finished",
  });

  return exitCode;
}
