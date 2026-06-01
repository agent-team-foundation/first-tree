import { type CliExecResult, execCli, type ExecCliOptions } from "./cli-driver/exec.js";

export type CliJsonResult<T> = {
  /** Parsed stdout JSON. */
  json: T;
  /** Raw stdout, kept for assertions that look at side-channel text. */
  stdout: string;
  /** Raw stderr, kept for failure diagnostics. */
  stderr: string;
  /** Resolved process exit code. Always 0 when this resolves successfully. */
  exitCode: number;
  /** Wall-clock duration of the spawned process. */
  durationMs: number;
};

/**
 * Run a one-shot CLI invocation that is expected to print a single JSON
 * document on stdout (typically commands invoked with `--json`).
 *
 * Failure modes that throw:
 *   - process exit code !== 0
 *   - stdout is empty
 *   - stdout is not valid JSON
 *
 * Each error message includes the args / cwd / captured stdio so vitest's
 * formatted failure has enough to debug without rerunning by hand.
 */
export async function runCliJson<T>(opts: ExecCliOptions): Promise<CliJsonResult<T>> {
  const result: CliExecResult = await execCli(opts);
  const ctx = `args=[${opts.args.join(" ")}] cwd=${opts.cwd ?? "<repo-root>"}`;

  if (result.exitCode !== 0) {
    throw new Error(
      `runCliJson: CLI exited with code ${result.exitCode} (${ctx})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(`runCliJson: CLI produced empty stdout (${ctx})\nstderr:\n${result.stderr}`);
  }

  let parsed: T;
  try {
    parsed = JSON.parse(result.stdout) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`runCliJson: stdout was not valid JSON (${ctx}): ${reason}\nstdout:\n${result.stdout}`);
  }

  return {
    json: parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
