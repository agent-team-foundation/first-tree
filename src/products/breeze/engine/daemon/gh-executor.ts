/**
 * Phase 3c: `gh` command executor with rate-limit throttling.
 *
 * Port of `first-tree-breeze/breeze-runner/src/gh_executor.rs`.
 *
 * This is the low-level `gh` runner used by the broker. It does two
 * things:
 *
 *   1. Classifies a command into a bucket (`core` / `search` / `write`)
 *      and decides whether it is mutating — so callers can consult
 *      `commandIsMutating` outside the executor.
 *   2. Runs the command with per-bucket throttling: search commands
 *      wait on `nextSearchEpochMs`, mutations additionally wait on
 *      `nextWriteEpochMs` plus `writeCooldownMs` after the previous
 *      write. On rate-limit detection (secondary / abuse / 429) we back
 *      off exponentially up to 60s·2^4 = 16 min per bucket and retry up
 *      to 3 times.
 *
 * The executor has no network code of its own — it shells out to a real
 * `gh` binary via `spawnGh`. Tests inject a fake spawn to drive the
 * state machine without invoking the network.
 *
 * Parity with Rust:
 *   - `bucketForArgs` mirrors `GhExecutor::bucket_for_args`.
 *   - `commandIsMutating` mirrors `command_is_mutating` including the
 *     `api -X METHOD` / `-f|-F|--field|--raw-field|--input` classifier.
 *   - `isRateLimited` scans stdout+stderr for the same five substrings.
 *   - Backoff is `60_000 * 2^min(streak, 4)` ms, same as Rust.
 *   - `wait_for_slot`'s 2s cap per sleep is preserved so the signal
 *     path can interrupt the loop promptly.
 */

import { spawn } from "node:child_process";

export type GhBucket = "core" | "search" | "write";

export interface GhCommandSpec {
  /** Diagnostic label used in error messages. */
  context: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra env vars layered on top of the current process env. */
  envs?: Record<string, string>;
  /** `gh`-specific argv (no leading binary). */
  args: string[];
  /** Pre-computed bucket; defaults to `bucketForArgs(args)`. */
  bucket?: GhBucket;
  /** Pre-computed mutation flag; defaults to `commandIsMutating(args)`. */
  mutating?: boolean;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  statusCode: number;
}

export interface GhExecutorOptions {
  /** Absolute path to the real `gh` binary. */
  realGh: string;
  /** Milliseconds required between consecutive write-bucket calls. */
  writeCooldownMs: number;
  /** Injected spawn function; tests pass a stub. */
  spawnGh?: (spec: GhCommandSpec) => Promise<ExecOutput>;
  /** Injected clock; tests pass a stub. */
  now?: () => number;
  /** Injected sleep; tests can short-circuit. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort signal; aborts the wait loop and skips further attempts. */
  signal?: AbortSignal;
}

export class GhExecutor {
  private readonly realGh: string;
  private readonly writeCooldownMs: number;
  private readonly spawnGh: (spec: GhCommandSpec) => Promise<ExecOutput>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal?: AbortSignal;

  private nextCoreEpochMs = 0;
  private nextSearchEpochMs = 0;
  private nextWriteEpochMs = 0;
  private lastWriteEpochMs = 0;
  private rateLimitStreak = 0;

  constructor(options: GhExecutorOptions) {
    this.realGh = options.realGh;
    this.writeCooldownMs = options.writeCooldownMs;
    this.spawnGh = options.spawnGh ?? defaultSpawnGh(options.realGh);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.signal = options.signal;
  }

  /** Normalize a spec so `bucket` and `mutating` are always set. */
  static normalize(spec: GhCommandSpec): Required<
    Pick<GhCommandSpec, "bucket" | "mutating">
  > &
    GhCommandSpec {
    return {
      ...spec,
      bucket: spec.bucket ?? bucketForArgs(spec.args),
      mutating: spec.mutating ?? commandIsMutating(spec.args),
    };
  }

  /**
   * Run with up to 3 retries on rate-limit detection. Returns the last
   * `ExecOutput` in all cases — callers inspect `statusCode` to decide
   * whether to surface an error.
   */
  async run(raw: GhCommandSpec): Promise<ExecOutput> {
    const spec = GhExecutor.normalize(raw);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.waitForSlot(spec);
      if (this.signal?.aborted) {
        return {
          stdout: "",
          stderr: "aborted before executing gh",
          statusCode: 124,
        };
      }
      const output = await this.spawnGh(spec);
      if (isRateLimited(output)) {
        this.registerRateLimit(spec);
        if (attempt + 1 < 3) continue;
        return output;
      }
      this.registerCompletion(spec);
      return output;
    }
    // Unreachable; the loop always returns.
    throw new Error("gh executor exhausted retries without returning");
  }

  /** Run and throw on non-zero exit, returning stdout on success. */
  async runChecked(raw: GhCommandSpec): Promise<string> {
    const spec = GhExecutor.normalize(raw);
    const output = await this.run(spec);
    if (output.statusCode !== 0) {
      throw new Error(
        `${spec.context} failed with exit code ${output.statusCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
    return output.stdout;
  }

  private async waitForSlot(spec: GhCommandSpec): Promise<void> {
    while (!this.signal?.aborted) {
      const now = this.now();
      let nextAllowed = this.nextCoreEpochMs;
      if (spec.bucket === "search") {
        nextAllowed = Math.max(nextAllowed, this.nextSearchEpochMs);
      }
      if (spec.mutating) {
        nextAllowed = Math.max(nextAllowed, this.nextWriteEpochMs);
        nextAllowed = Math.max(
          nextAllowed,
          this.lastWriteEpochMs + this.writeCooldownMs,
        );
      }
      const waitMs = Math.max(0, nextAllowed - now);
      if (waitMs === 0) return;
      await this.sleep(Math.min(waitMs, 2_000));
    }
  }

  private registerCompletion(spec: GhCommandSpec): void {
    this.rateLimitStreak = 0;
    if (spec.mutating) {
      this.lastWriteEpochMs = this.now();
    }
  }

  private registerRateLimit(spec: GhCommandSpec): void {
    this.rateLimitStreak = Math.min(this.rateLimitStreak + 1, 1_000);
    const exponent = Math.min(this.rateLimitStreak, 4);
    const backoffMs = 60_000 * 2 ** exponent;
    const nextAllowed = this.now() + backoffMs;
    this.nextCoreEpochMs = Math.max(this.nextCoreEpochMs, nextAllowed);
    if (spec.bucket === "search") {
      this.nextSearchEpochMs = Math.max(this.nextSearchEpochMs, nextAllowed);
    }
    if (spec.mutating) {
      this.nextWriteEpochMs = Math.max(this.nextWriteEpochMs, nextAllowed);
    }
  }

  /** Diagnostic snapshot; tests use this to assert state transitions. */
  getState(): {
    nextCoreEpochMs: number;
    nextSearchEpochMs: number;
    nextWriteEpochMs: number;
    lastWriteEpochMs: number;
    rateLimitStreak: number;
  } {
    return {
      nextCoreEpochMs: this.nextCoreEpochMs,
      nextSearchEpochMs: this.nextSearchEpochMs,
      nextWriteEpochMs: this.nextWriteEpochMs,
      lastWriteEpochMs: this.lastWriteEpochMs,
      rateLimitStreak: this.rateLimitStreak,
    };
  }
}

/** Mirrors `GhExecutor::bucket_for_args`. */
export function bucketForArgs(args: readonly string[]): GhBucket {
  const first = args[0];
  if (first === "search") return "search";
  if (first === "api") {
    const path = args[1] ?? "";
    if (
      path.startsWith("search/") ||
      path.includes("/search/") ||
      path.includes("search/")
    ) {
      return "search";
    }
  }
  if (commandIsMutating(args)) return "write";
  return "core";
}

/** Mirrors `command_is_mutating`. */
export function commandIsMutating(args: readonly string[]): boolean {
  const first = args[0];
  if (first === undefined) return false;
  switch (first) {
    case "api":
      return apiCommandIsMutating(args);
    case "issue":
      return new Set([
        "comment",
        "close",
        "create",
        "delete",
        "edit",
        "lock",
        "pin",
        "reopen",
        "transfer",
        "unlock",
        "unpin",
      ]).has(args[1] ?? "");
    case "pr":
      return new Set([
        "close",
        "comment",
        "create",
        "edit",
        "merge",
        "ready",
        "reopen",
        "review",
        "update-branch",
      ]).has(args[1] ?? "");
    case "label":
      return new Set(["clone", "create", "delete", "edit"]).has(args[1] ?? "");
    default:
      return false;
  }
}

function apiCommandIsMutating(args: readonly string[]): boolean {
  let explicitMethod: string | undefined;
  let hasFields = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-X" || arg === "--method") {
      const next = args[i + 1];
      if (next !== undefined) {
        explicitMethod = next.toUpperCase();
      }
      i += 1;
    } else if (
      arg === "-f" ||
      arg === "-F" ||
      arg === "--field" ||
      arg === "--raw-field" ||
      arg === "--input"
    ) {
      hasFields = true;
    }
  }
  if (explicitMethod === "GET" || explicitMethod === "HEAD") return false;
  if (explicitMethod !== undefined) return true;
  return hasFields;
}

/** Mirrors `is_rate_limited` in gh_executor.rs. */
export function isRateLimited(output: ExecOutput): boolean {
  const combined = `${output.stdout}\n${output.stderr}`.toLowerCase();
  return (
    combined.includes("secondary rate limit") ||
    combined.includes("rate limit exceeded") ||
    combined.includes("api rate limit") ||
    combined.includes("abuse detection") ||
    combined.includes("retry after")
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnGh(realGh: string) {
  return async (spec: GhCommandSpec): Promise<ExecOutput> =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, ...(spec.envs ?? {}) };
      const child = spawn(realGh, spec.args, {
        cwd: spec.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout, stderr, statusCode: code ?? 1 });
      });
    });
}
