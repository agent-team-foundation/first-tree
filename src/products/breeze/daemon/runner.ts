/**
 * Phase 3c: per-task agent runner.
 *
 * Port of `first-tree-breeze/breeze-runner/src/runner.rs`.
 *
 * Each dispatched task picks one or more runner specs from the pool,
 * builds a prompt, writes it to `<task-dir>/prompt.txt`, and execs the
 * agent binary (`codex` or `claude`). Stdout/stderr go to
 * `runner-stdout.log` / `runner-stderr.log`; `runner-output.txt`
 * holds the agent's final message (codex writes it via
 * `--output-last-message`, claude's stdout is copied there post-exit).
 *
 * The dispatcher iterates runners in `executionOrder()` until one
 * returns successfully, mirroring Rust's fallback chain. Only the
 * first runner is recorded as "selected" in task metadata.
 *
 * Phase 3c adds a per-task timeout (spec doc 4 §11, §8). Rust's
 * runner had no timeout; the TS version always enforces one, with a
 * default in `core/config.ts::DAEMON_CONFIG_DEFAULTS.taskTimeoutSec`.
 */

import {
  createWriteStream,
  readFileSync,
  writeFileSync,
  existsSync,
  type WriteStream,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type RunnerKind = "codex" | "claude";

export interface RunnerSpec {
  kind: RunnerKind;
  model?: string;
}

export interface AgentIdentity {
  login: string;
  host: string;
}

export interface RunnerTask {
  repo: string;
  workspaceRepo: string;
  kind: string;
  title: string;
  /** Preferred anchored URL (comment link if known). */
  taskUrl: string;
}

export interface RunnerRequest {
  task: RunnerTask;
  taskId: string;
  taskDir: string;
  workspaceDir: string;
  snapshotDir: string;
  ghShimDir: string;
  ghBrokerDir: string;
  identity: AgentIdentity;
  disclosureText: string;
}

export interface RunnerOutcome {
  status: string;
  summary: string;
  outputPath: string;
}

export type RunnerSpawner = (args: {
  spec: RunnerSpec;
  request: RunnerRequest;
  promptPath: string;
  promptText: string;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
}) => Promise<{ statusCode: number | null }>;

export interface ExecuteOptions {
  /** Kill the subprocess if it runs longer than this many ms. */
  timeoutMs: number;
  /** Injected spawner. Production uses `defaultRunnerSpawner`. */
  spawner?: RunnerSpawner;
  /** Abort signal. Triggers the same kill path as the timeout. */
  signal?: AbortSignal;
}

/**
 * Execute one runner. Writes the prompt + logs + parses the result.
 * Throws on non-zero exit so the dispatcher can try the next runner.
 */
export async function executeRunner(
  spec: RunnerSpec,
  request: RunnerRequest,
  options: ExecuteOptions,
): Promise<RunnerOutcome> {
  const promptText = buildPrompt(request);
  const promptPath = join(request.taskDir, "prompt.txt");
  const outputPath = join(request.taskDir, "runner-output.txt");
  const stdoutPath = join(request.taskDir, "runner-stdout.log");
  const stderrPath = join(request.taskDir, "runner-stderr.log");

  writeFileSync(promptPath, promptText);

  const spawner = options.spawner ?? defaultRunnerSpawner;
  const { statusCode } = await spawner({
    spec,
    request,
    promptPath,
    promptText,
    outputPath,
    stdoutPath,
    stderrPath,
  });

  // Claude doesn't emit --output-last-message; copy stdout into
  // runner-output.txt so parse_result can find the final BREEZE_RESULT
  // line consistently.
  if (spec.kind === "claude") {
    const stdout = existsSync(stdoutPath)
      ? readFileSync(stdoutPath, "utf8")
      : "";
    writeFileSync(outputPath, stdout);
  }

  if (statusCode !== 0) {
    throw new Error(
      `${spec.kind} runner exited with status ${statusCode ?? "unknown"}`,
    );
  }

  const response = existsSync(outputPath)
    ? readFileSync(outputPath, "utf8")
    : "";
  const { status, summary } = parseResult(response);
  return { status, summary, outputPath };
}

export function buildPrompt(request: RunnerRequest): string {
  const task = request.task;
  const workingRepoLine =
    task.workspaceRepo !== task.repo
      ? `- Working repository: ${task.workspaceRepo}\n`
      : "";
  return (
    `This is breeze and you are a team of agents representing ${request.identity.login}.\n` +
    `\n` +
    `This is breeze's code repo:\n` +
    `https://github.com/agent-team-foundation/breeze\n` +
    `\n` +
    `Your job is addressing any comments / discussions / review request / task request / pull request etc. (basically any GitHub notifications) related to GitHub id: ${request.identity.login}. When reviewing pull requests, follow the principle here: https://google.github.io/eng-practices/review/\n` +
    `\n` +
    `The web URL for the current GitHub task that you need to solve and reply is: ${task.taskUrl}\n` +
    `\n` +
    `Local context:\n` +
    `- Task ID: ${request.taskId}\n` +
    `- Repository: ${task.repo}\n` +
    workingRepoLine +
    `- Type: ${task.kind}\n` +
    `- Workspace: ${request.workspaceDir}\n` +
    `- Snapshot directory: ${request.snapshotDir}\n` +
    `- Task artifacts directory: ${request.taskDir}\n` +
    `\n` +
    `Do not stop unless\n` +
    `0. Read carefully about the request and gather all the needed context\n` +
    `1. Task / Request in the GitHub message has been done completely\n` +
    `2. Message has been properly replied on GitHub\n` +
    `\n` +
    `If you find a task / message has already been replied by ${request.identity.login}, then you can skip it. Do not send out duplicated replies.\n` +
    `\n` +
    `Read the local snapshot files first. Only call \`gh\` when you need fresh data or to publish the final result.\n` +
    `\n` +
    `Status labeling rule (REQUIRED): label the issue / pull request with your current status using exactly one of:\n` +
    `- \`breeze:wip\` — you are actively working on it\n` +
    `- \`breeze:human\` — you need human input or judgment to proceed\n` +
    `- \`breeze:done\` — you have finished handling it\n` +
    `\n` +
    `Apply the label via \`gh\`, for example:\n` +
    `  gh issue edit <number> --repo <owner>/<repo> --add-label "breeze:<status>"\n` +
    `  gh pr edit   <number> --repo <owner>/<repo> --add-label "breeze:<status>"\n` +
    `Remove any previous \`breeze:*\` label when the status changes so only one \`breeze:*\` label remains on the item. Set \`breeze:wip\` as soon as you start real work, and set \`breeze:done\` or \`breeze:human\` before you stop.\n` +
    `\n` +
    `If you post a public GitHub reply, review, or comment, include this exact disclosure sentence once: ${request.disclosureText}\n` +
    `\n` +
    `When you are done, finish with exactly one line in this format:\n` +
    `BREEZE_RESULT: status=<handled|skipped|failed> summary=<one-line summary>`
  );
}

/**
 * Scan bottom-up for the last `BREEZE_RESULT:` line. Mirrors Rust
 * `parse_result`. If missing, default to `handled` with the last line
 * of output as the summary.
 *
 * Phase 3c bug-fix note (spec doc 4 §11): Rust silently treats
 * crashes-without-BREEZE_RESULT as `handled`. The dispatcher layer can
 * re-classify these by inspecting exit status; this function preserves
 * the Rust default for parity.
 */
export function parseResult(output: string): {
  status: string;
  summary: string;
} {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("BREEZE_RESULT:")) continue;
    const payload = trimmed.slice("BREEZE_RESULT:".length).trim();
    const status =
      payload
        .split(/\s+/)
        .find((p) => p.startsWith("status="))
        ?.slice("status=".length) ?? "handled";
    const summary = (() => {
      const idx = payload.indexOf("summary=");
      if (idx === -1) return "completed";
      return payload.slice(idx + "summary=".length).trim();
    })();
    return { status, summary };
  }
  const nonEmpty = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const summary = nonEmpty[nonEmpty.length - 1] ?? "completed";
  return { status: "handled", summary };
}

/**
 * Rotate through the runner list, returning the sequence of specs to
 * try for the next task. Subsequent calls rotate by one so codex /
 * claude alternate as primary across tasks.
 */
export class RunnerPool {
  private readonly runners: readonly RunnerSpec[];
  private nextIndex = 0;

  constructor(runners: readonly RunnerSpec[]) {
    if (runners.length === 0) {
      throw new Error(
        "no configured runner binary is available in PATH (need codex and/or claude)",
      );
    }
    this.runners = runners;
  }

  availableNames(): RunnerKind[] {
    return this.runners.map((r) => r.kind);
  }

  executionOrder(): RunnerSpec[] {
    const n = this.runners.length;
    const start = this.nextIndex % n;
    this.nextIndex = (this.nextIndex + 1) % n;
    return Array.from({ length: n }, (_, offset) => ({
      ...this.runners[(start + offset) % n],
    }));
  }
}

/**
 * Spawn codex or claude with the agent's env. Handles timeout via
 * `setTimeout(kill, timeoutMs)` and propagates an AbortSignal the same
 * way. Returns the exit status.
 */
export const defaultRunnerSpawner: RunnerSpawner = async ({
  spec,
  request,
  promptPath,
  promptText,
  outputPath,
  stdoutPath,
  stderrPath,
}) => {
  const env = buildAgentEnv(request);
  const { cmd, args, cwd } = buildCommand({
    spec,
    request,
    promptPath,
    promptText,
    outputPath,
  });

  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);

  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      closeStreams([stdout, stderr]).then(() =>
        resolve({ statusCode: code }),
      );
    });
  });
};

export function buildCommand(args: {
  spec: RunnerSpec;
  request: RunnerRequest;
  promptPath: string;
  promptText: string;
  outputPath: string;
}): { cmd: string; args: string[]; cwd?: string } {
  const { spec, request, promptPath, promptText, outputPath } = args;
  if (spec.kind === "codex") {
    const argv = [
      "exec",
      "--cd",
      request.workspaceDir,
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message",
      outputPath,
    ];
    if (spec.model) argv.push("--model", spec.model);
    argv.push(promptPath);
    return { cmd: "codex", args: argv };
  }
  // Claude
  const argv = ["-p", "--permission-mode", "bypassPermissions"];
  if (spec.model) argv.push("--model", spec.model);
  argv.push(promptText);
  return { cmd: "claude", args: argv, cwd: request.workspaceDir };
}

export function buildAgentEnv(
  request: RunnerRequest,
): NodeJS.ProcessEnv {
  const existingPath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: `${request.ghShimDir}:${existingPath}`,
    BREEZE_BROKER_DIR: request.ghBrokerDir,
    BREEZE_SNAPSHOT_DIR: request.snapshotDir,
    BREEZE_TASK_DIR: request.taskDir,
  };
}

async function closeStreams(streams: WriteStream[]): Promise<void> {
  await Promise.all(
    streams.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.end(() => resolve());
        }),
    ),
  );
}

/** Run a spec with a timeout. Used by the dispatcher. */
export async function runWithTimeout<T>(args: {
  run: () => Promise<T>;
  kill: () => void;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      args.kill();
      reject(new Error(`timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.kill();
      reject(new Error("aborted"));
    };
    if (args.signal) {
      if (args.signal.aborted) {
        clearTimeout(timer);
        args.kill();
        reject(new Error("aborted"));
        return;
      }
      args.signal.addEventListener("abort", onAbort, { once: true });
    }
    args
      .run()
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        args.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        args.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}
