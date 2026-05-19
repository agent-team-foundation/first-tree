import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { REPO_ROOT } from "../env.js";

const CLI_ENTRY = resolve(REPO_ROOT, "packages/command/dist/cli/index.mjs");

export type CliEnvOptions = {
  /** Per-CLI FIRST_TREE_HUB_HOME, where credentials.json / client.yaml live. */
  home: string;
  /** Per-CLI Hub URL — wins over any ambient `FIRST_TREE_HUB_SERVER_URL`. */
  serverBaseUrl: string;
  /** Optional extra env overrides (claude/codex executable paths, etc.). */
  extraEnv?: NodeJS.ProcessEnv;
};

/**
 * Build the env the framework spawns the dist CLI with.
 *
 * Why the sanitization step matters: when the e2e harness itself runs inside
 * an agent runtime (e.g. yzw-assistant on prod hub), the parent process
 * exports `FIRST_TREE_HUB_SERVER_URL` and friends. The CLI config resolver
 * gives env > file priority, so without this step a per-run `client.yaml`
 * gets silently overridden by the parent's prod URL, and the WS handshake
 * fails with a JWT-secret mismatch. Re-injecting only the values we own
 * makes the spawned CLI behave as if it were started from a clean shell.
 */
export function buildCliEnv(opts: CliEnvOptions): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("FIRST_TREE_HUB_")) continue;
    sanitized[k] = v;
  }
  return {
    ...sanitized,
    NODE_ENV: "test",
    FIRST_TREE_HUB_HOME: opts.home,
    FIRST_TREE_HUB_SERVER_URL: opts.serverBaseUrl,
    ...opts.extraEnv,
  };
}

export type CliExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

export type ExecCliOptions = CliEnvOptions & {
  /** Argv after `node dist/cli/index.mjs`. e.g. ["chat", "send", "<name>", "hi"]. */
  args: string[];
  /** Hard wall-clock timeout in ms. Default 30s. */
  timeoutMs?: number;
};

/**
 * Run the dist CLI to completion and capture its stdout / stderr / exit code.
 * Use this for one-shot commands like `connect`, `agent list`, `chat send`
 * etc. Long-running entries (`client start --foreground`) belong on
 * `spawnCli` below — they never exit on their own.
 */
export async function execCli(opts: ExecCliOptions): Promise<CliExecResult> {
  const env = buildCliEnv(opts);
  const started = Date.now();
  const child = spawn(process.execPath, [CLI_ENTRY, ...opts.args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => {
    stdout += c.toString("utf8");
  });
  child.stderr?.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  return new Promise<CliExecResult>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `CLI exec timeout after ${opts.timeoutMs ?? 30_000}ms — args=[${opts.args.join(
            " ",
          )}]\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, opts.timeoutMs ?? 30_000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr,
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
      });
    });
  });
}

export type SpawnedCli = {
  pid: number;
  child: ChildProcess;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

export type SpawnCliOptions = CliEnvOptions & {
  args: string[];
  /** Optional logger that receives every stdio chunk. */
  logger?: { pipe: (chunk: Buffer | string) => void };
  /**
   * Wait this long after spawn to confirm the child didn't exit immediately
   * (e.g. due to missing credentials). Default 1500ms.
   */
  immediateExitGraceMs?: number;
};

/**
 * Spawn a long-running CLI process. The promise resolves once the child has
 * survived `immediateExitGraceMs` without exiting; the returned handle exposes
 * the underlying `ChildProcess` plus a `stop()` that does SIGTERM → SIGKILL
 * fallback. Use for `client start --foreground`, `connect --no-service`, etc.
 */
export async function spawnCli(opts: SpawnCliOptions): Promise<SpawnedCli> {
  const env = buildCliEnv(opts);
  const child = spawn(process.execPath, [CLI_ENTRY, ...opts.args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  if (opts.logger) {
    child.stdout?.on("data", (c) => opts.logger?.pipe(c));
    child.stderr?.on("data", (c) => opts.logger?.pipe(c));
  }
  await new Promise<void>((resolveOk, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited during startup (code=${code}, signal=${signal}, args=[${opts.args.join(" ")}])`));
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveOk();
    }, opts.immediateExitGraceMs ?? 1_500);
    child.once("exit", onExit);
  });
  return {
    pid: child.pid ?? -1,
    child,
    stop: (signal = "SIGTERM") => killChild(child, signal),
  };
}

async function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  const timer = new Promise<void>((r) =>
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      r();
    }, 5_000),
  );
  await Promise.race([done, timer]);
}
