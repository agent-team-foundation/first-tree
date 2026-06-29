import { spawn } from "node:child_process";

/**
 * Low-level spawn helpers.
 *
 * Capability detection itself is install-only (see `detect.ts`) and never
 * launches a provider. These helpers remain only for the codex runtime-binary
 * resolver (`resolveCodexRuntimeBinary`) shared with the handler + login flow,
 * which still launch-verifies the binary it is about to spawn at runtime.
 */

export type RunCommandResult = {
  /** True when the process spawned, exited on its own, and returned code 0. */
  ok: boolean;
  /** Exit code; null when the process did not exit normally (signal/timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES, …) — the launch itself failed. */
  spawnError?: string;
  timedOut: boolean;
  durationMs: number;
};

/**
 * Async command runner. Unlike `spawnSync`, this does not block the event loop.
 * stdin is closed immediately so binaries that wait for terminal input fail
 * fast instead of hanging until the timeout.
 */
export async function runCommand(
  binary: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string } = { timeoutMs: 10_000 },
): Promise<RunCommandResult> {
  const startedAt = Date.now();
  return await new Promise<RunCommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (partial: Pick<RunCommandResult, "ok" | "exitCode" | "spawnError">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...partial, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, exitCode: null, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      finish({ ok: false, exitCode: null, spawnError: err.message });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: code });
    });
  });
}

/**
 * Spawn `<binary> --version` to prove the artifact really launches, and
 * extract the version. Used by the codex runtime-binary resolver shared with
 * the handler; the capability probe does NOT call this.
 */
export async function verifyLaunchable(
  label: string,
  binary: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; version: string | null } | { ok: false; error: string }> {
  const res = await runCommand(binary, ["--version"], { timeoutMs: opts.timeoutMs ?? 10_000 });
  if (!res.ok) return { ok: false, error: commandFailureDigest(`${label} --version`, res) };
  const match = res.stdout.match(/\d+\.\d+(?:\.\d+)?/);
  return { ok: true, version: match ? match[0] : null };
}

/**
 * One-line digest of a failed command: prefers stderr, falls back to stdout,
 * then to an exit-code note.
 */
export function commandFailureDigest(label: string, res: RunCommandResult): string {
  if (res.spawnError) return `${label}: ${res.spawnError}`;
  if (res.timedOut) return `${label}: timed out after ${res.durationMs}ms`;
  const output = [res.stderr.trim(), res.stdout.trim()].filter((s) => s.length > 0).join(" | ");
  if (output.length > 0) return `${label}: ${output}`;
  return `${label}: exited with code ${res.exitCode ?? "unknown"}`;
}
