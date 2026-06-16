import { spawn } from "node:child_process";
import type { CapabilityAuthMethod, CapabilityEntry } from "@first-tree/shared";

/**
 * Launch-verified capability probing — the shared three-stage contract every
 * provider probe implements.
 *
 * Design principle (replacing the legacy import/marker heuristics): a probe
 * may report `ok` ONLY after really launching the provider; any failure is
 * reported with the provider's own output verbatim so the user sees the real
 * error, not a generic label.
 *
 * Stages, in order — the first failing stage short-circuits:
 *   1. resolve        — locate the artifact the runtime would actually spawn
 *                       and verify it launches (`--version`). Failure → `missing`.
 *   2. auth precheck  — a free, local/fast credential gate (e.g. `codex login
 *                       status`, Claude's OAuth marker). Its only authority is
 *                       NEGATIVE: a failed precheck short-circuits to
 *                       `unauthenticated` (saves a smoke that would fail
 *                       slowly); a passing precheck proves nothing — only the
 *                       smoke can yield `ok`.
 *   3. smoke          — a real minimal end-to-end launch (1-turn session or
 *                       authenticated handshake). The ONLY path to `ok`.
 *
 * Each stage is injectable per provider so unit tests stay hermetic (no real
 * spawns, no network) while production uses the real implementations.
 */

/** Outcome of stage 1 — resolving + launch-verifying the provider artifact. */
export type ResolveOutcome =
  | {
      ok: true;
      /**
       * Absolute path of the binary the runtime would spawn, when one was
       * resolved on disk. `undefined` means the runtime uses an SDK-internal
       * launch path that cannot be pre-resolved here (the smoke still
       * exercises it for real).
       */
      binary?: string;
      /** Provider version as reported by the real binary/package, if known. */
      version: string | null;
      /**
       * Extra provider-specific entry fields learned during resolve (e.g.
       * codex's `runtimeSource` / `runtimePath`). Merged into every
       * post-resolve entry (`ok` / `unauthenticated` / smoke outcomes) so the
       * runtime-binary provenance is reported regardless of auth state.
       */
      meta?: Partial<CapabilityEntry>;
    }
  | { ok: false; error: string };

/** Outcome of stage 2 — the free auth precheck. */
export type AuthPrecheckOutcome = { ok: true; method: CapabilityAuthMethod } | { ok: false; error: string };

/** Outcome of stage 3 — the real launch smoke. */
export type SmokeOutcome = {
  state: "ok" | "unauthenticated" | "missing" | "error";
  /** Required for every non-`ok` state: the provider's own message, verbatim. */
  error?: string;
  /** Version learned during the smoke (overrides the resolve-stage version). */
  version?: string | null;
  /** Auth method confirmed by the smoke (overrides the precheck's guess). */
  method?: CapabilityAuthMethod;
  /** True when the smoke fell back to a weaker verification (see schema). */
  degraded?: boolean;
};

export type LaunchProbeStages = {
  resolve: () => Promise<ResolveOutcome>;
  authPrecheck: (resolved: ResolveOutcome & { ok: true }) => Promise<AuthPrecheckOutcome>;
  smoke: (resolved: ResolveOutcome & { ok: true }, auth: AuthPrecheckOutcome & { ok: true }) => Promise<SmokeOutcome>;
};

/** Cap stored error text — provider output can be arbitrarily long. */
export const MAX_ERROR_LENGTH = 500;

export function truncateError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ERROR_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_LENGTH)}…`;
}

/**
 * Run the three stages and translate the first failure (or final success)
 * into a `CapabilityEntry`. Never throws — an unexpected exception becomes a
 * `state: "error"` entry carrying the exception message.
 */
export async function runLaunchProbe(stages: LaunchProbeStages): Promise<CapabilityEntry> {
  const startedAt = Date.now();
  const detectedAt = new Date(startedAt).toISOString();
  const base = { detectedAt, probeKind: "launch" as const };
  const done = <T extends Omit<CapabilityEntry, "detectedAt" | "probeKind" | "latencyMs">>(
    entry: T,
  ): CapabilityEntry => ({
    ...entry,
    ...base,
    latencyMs: Date.now() - startedAt,
  });

  try {
    const resolved = await stages.resolve();
    if (!resolved.ok) {
      return done({
        state: "missing",
        available: false,
        authenticated: false,
        sdkVersion: null,
        authMethod: "none",
        error: truncateError(resolved.error),
      });
    }

    // Provenance learned during resolve (e.g. runtimeSource/runtimePath) is
    // reported on every post-resolve entry, independent of auth/smoke outcome.
    const meta = resolved.meta ?? {};

    const auth = await stages.authPrecheck(resolved);
    if (!auth.ok) {
      return done({
        ...meta,
        state: "unauthenticated",
        available: true,
        authenticated: false,
        sdkVersion: resolved.version,
        authMethod: "none",
        error: truncateError(auth.error),
      });
    }

    const smoke = await stages.smoke(resolved, auth);
    const version = smoke.version !== undefined ? smoke.version : resolved.version;
    const method = smoke.method ?? auth.method;
    switch (smoke.state) {
      case "ok":
        return done({
          ...meta,
          state: "ok",
          available: true,
          authenticated: true,
          sdkVersion: version,
          authMethod: method,
          ...(smoke.degraded ? { degraded: true } : {}),
        });
      case "unauthenticated":
        return done({
          ...meta,
          state: "unauthenticated",
          available: true,
          authenticated: false,
          sdkVersion: version,
          authMethod: "none",
          error: truncateError(smoke.error ?? "authentication failed"),
        });
      case "missing":
        return done({
          ...meta,
          state: "missing",
          available: false,
          authenticated: false,
          sdkVersion: version,
          authMethod: "none",
          error: truncateError(smoke.error ?? "provider binary not found"),
        });
      case "error":
        return done({
          ...meta,
          state: "error",
          available: false,
          authenticated: false,
          sdkVersion: version,
          authMethod: "none",
          error: truncateError(smoke.error ?? "probe failed"),
        });
    }
  } catch (err) {
    return done({
      state: "error",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      error: truncateError(err instanceof Error ? err.message : String(err)),
    });
  }
}

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
 * Async command runner for probe stages. Unlike `spawnSync`, this does not
 * block the event loop — the three provider probes run concurrently at daemon
 * start, and a smoke can legitimately take seconds.
 *
 * stdin is closed immediately so providers that wait for terminal input fail
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
 * extract the version. This is the canonical resolve-stage verification:
 * `existsSync` alone admits non-executable files, wrong-arch binaries, and
 * dangling overrides — only a real spawn rules those out.
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
 * One-line digest of a failed command for `error` fields: prefers stderr,
 * falls back to stdout, then to an exit-code note. Providers print auth
 * errors on either stream (claude prints "Invalid API key" on stdout).
 */
export function commandFailureDigest(label: string, res: RunCommandResult): string {
  if (res.spawnError) return `${label}: ${res.spawnError}`;
  if (res.timedOut) return `${label}: timed out after ${res.durationMs}ms`;
  const output = [res.stderr.trim(), res.stdout.trim()].filter((s) => s.length > 0).join(" | ");
  if (output.length > 0) return `${label}: ${output}`;
  return `${label}: exited with code ${res.exitCode ?? "unknown"}`;
}
