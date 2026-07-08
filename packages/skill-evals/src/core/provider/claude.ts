import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

import { appendEvent, previewText } from "../events.js";
import { isShimTraceLine } from "../reporter.js";
import type { ProviderRunContext, ProviderRunOptions } from "./types.js";

const ALLOWED_ENV_KEYS = new Set([
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "USER",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

const SYSTEM_PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"] as const;

function pathParts(pathValue: string | undefined): readonly string[] {
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

function uniquePath(dirs: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    kept.push(dir);
  }
  return kept.join(delimiter);
}

export function claudeProviderCommand(options: ProviderRunOptions, sourceEnv: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(options.bin)) return options.bin;
  for (const dir of pathParts(sourceEnv.PATH)) {
    const candidate = join(dir, options.bin);
    if (existsSync(candidate)) return candidate;
  }
  return options.bin;
}

export function claudeProviderArgs(options: ProviderRunOptions): string[] {
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
  ];
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  return args;
}

export function claudeProviderEnv(
  options: ProviderRunOptions,
  context: ProviderRunContext,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const command = claudeProviderCommand(options, sourceEnv);
  const providerHome = join(context.paths.runRoot, "provider-home");
  const providerTmp = join(context.paths.runRoot, "provider-tmp");
  const providerXdgCache = join(context.paths.runRoot, "provider-xdg-cache");
  const providerXdgConfig = join(context.paths.runRoot, "provider-xdg-config");
  for (const dir of [providerHome, providerTmp, providerXdgCache, providerXdgConfig]) {
    mkdirSync(dir, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }

  env.BASH_ENV = join(context.paths.shellEnvDir, "bash-env");
  env.ENV = join(context.paths.shellEnvDir, "sh-env");
  env.FIRST_TREE_EVAL_CASE_ID = options.caseId;
  env.FIRST_TREE_EVAL_EVENTS = context.paths.modelEventsPath;
  env.FIRST_TREE_EVAL_PHASE = "model";
  env.FIRST_TREE_EVAL_VERBOSE = options.verbose ? "1" : "0";
  env.HOME = providerHome;
  env.PATH = uniquePath([
    context.paths.binDir,
    dirname(process.execPath),
    isAbsolute(command) ? dirname(command) : null,
    ...SYSTEM_PATH_DIRS,
  ]);
  env.TEMP = providerTmp;
  env.TMP = providerTmp;
  env.TMPDIR = providerTmp;
  env.XDG_CACHE_HOME = providerXdgCache;
  env.XDG_CONFIG_HOME = providerXdgConfig;
  env.ZDOTDIR = context.paths.shellEnvDir;
  return env;
}

async function consumeClaudeStdout(
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
        type: "claude_event",
      });
      appendEvent(eventsPath, {
        event,
        type: "codex_event",
      });
      context.reporter.codexEvent(event);
    } catch {
      appendEvent(eventsPath, {
        linePreview: previewText(line),
        type: "claude_stdout",
      });
      context.reporter.codexStdoutLine(line);
    }
  }
}

async function consumeClaudeStderr(
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
        type: "claude_stderr",
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
        type: "claude_spawn_error",
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
        type: "claude_process_closed",
      });
      context.reporter.codexProcessFinished(code ?? 1);
      resolve(code ?? 1);
    });
  });
}

function appendModelEvents(context: ProviderRunContext): void {
  if (!existsSync(context.paths.modelEventsPath)) return;
  const modelEvents = readFileSync(context.paths.modelEventsPath, "utf8");
  if (!modelEvents.trim()) return;
  appendFileSync(context.paths.eventsPath, modelEvents.endsWith("\n") ? modelEvents : `${modelEvents}\n`, "utf8");
}

export async function runClaudeProvider(options: ProviderRunOptions, context: ProviderRunContext): Promise<number> {
  const command = claudeProviderCommand(options);
  const env = claudeProviderEnv(options, context);
  const args = claudeProviderArgs(options);
  appendEvent(context.paths.eventsPath, {
    args,
    caseId: options.caseId,
    command,
    envKeys: Object.keys(env).sort(),
    type: "claude_run_started",
  });
  context.reporter.codexProcessStarted(args);

  const child = spawn(command, args, {
    cwd: context.paths.workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const streamTasks: Promise<void>[] = [];
  if (child.stdout) streamTasks.push(consumeClaudeStdout(context.paths.eventsPath, child.stdout, context));
  if (child.stderr) streamTasks.push(consumeClaudeStderr(context.paths.eventsPath, child.stderr, context));

  const exitCode = await waitForChildExit(child, context);
  await Promise.all(streamTasks);
  appendModelEvents(context);

  appendEvent(context.paths.eventsPath, {
    caseId: options.caseId,
    exitCode,
    type: "claude_run_finished",
  });

  return exitCode;
}
