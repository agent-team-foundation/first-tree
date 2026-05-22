/**
 * Thin wrapper around the `gh` CLI for github-scan TS commands.
 *
 * Mirrors the behaviour the bash scripts rely on:
 *   - `gh api <path>` for raw REST/GraphQL calls
 *   - `gh issue edit <num> --repo o/r --add-label L` / `--remove-label L`
 *   - `gh label create L --repo o/r --color C --description D --force`
 *
 * All calls go through a single inject-able spawn function so tests
 * can stub them deterministically. Errors from `gh` are surfaced as
 * `GhExecError` with stderr captured; callers choose whether to
 * swallow (status-manager does `|| true` for every label op).
 */

import {
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";

export interface GhExecResult {
  /** `gh` exit code. `null` if the process was signal-killed. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export class GhExecError extends Error {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly argv: readonly string[];
  constructor(argv: readonly string[], result: GhExecResult, action: string) {
    const head = result.stderr.split("\n")[0]?.trim();
    super(`gh ${action} failed (exit ${result.status ?? "signal"})${head ? `: ${head}` : ""}`);
    this.status = result.status;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
    this.argv = argv;
  }
}

export type GhSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithBufferEncoding,
) => SpawnSyncReturns<Buffer>;

export interface GhClientDeps {
  /** Spawn helper — defaults to `child_process.spawnSync`. */
  spawn?: GhSpawnFn;
  /** Binary name/path; defaults to `"gh"`. */
  binary?: string;
  /**
   * Max bytes captured from gh's stdout/stderr. Defaults to 64 MiB
   * — the default `spawnSync` cap of ~1 MiB is trivially exceeded by
   * `gh api notifications` on accounts with a few hundred threads,
   * which makes the whole poll cycle fail with ENOBUFS.
   */
  maxBufferBytes?: number;
}

/**
 * 64 MiB. Big enough for a fully-hydrated `gh api notifications`
 * payload on heavy accounts (observed ~1 MB empirically, but GitHub
 * can return much more when repos expand), still a tiny fraction of
 * process RAM so we'd rather cap than hang.
 */
export const DEFAULT_GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export class GhClient {
  private readonly spawn: GhSpawnFn;
  private readonly binary: string;
  private readonly maxBuffer: number;

  constructor(deps: GhClientDeps = {}) {
    this.spawn = deps.spawn ?? (spawnSync as GhSpawnFn);
    this.binary = deps.binary ?? "gh";
    this.maxBuffer = deps.maxBufferBytes ?? DEFAULT_GH_MAX_BUFFER_BYTES;
  }

  /**
   * Run `gh` with the provided argv. Does not throw on non-zero exit;
   * callers inspect `status`.
   */
  run(args: readonly string[]): GhExecResult {
    const result = this.spawn(this.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: this.maxBuffer,
    });
    if (result.error) {
      return {
        status: null,
        stdout: "",
        stderr: String(result.error.message ?? result.error),
      };
    }
    return {
      status: typeof result.status === "number" ? result.status : null,
      stdout: result.stdout?.toString("utf-8") ?? "",
      stderr: result.stderr?.toString("utf-8") ?? "",
    };
  }

  /** Run and throw if non-zero exit. Used when a failure is a real error. */
  runChecked(action: string, args: readonly string[]): string {
    const result = this.run(args);
    if (result.status !== 0) {
      throw new GhExecError(args, result, action);
    }
    return result.stdout;
  }

  /**
   * Add a label to a PR/issue, creating it first if the repo lacks it.
   * Mirrors the historical label helper in the shell prototype.
   * All errors are swallowed (silent "non-labeler fallback", spec doc 3 §8).
   */
  addLabelWithFallback(
    repo: string,
    number: number,
    label: string,
    color: string,
    description: string,
  ): void {
    const first = this.run(["issue", "edit", String(number), "--repo", repo, "--add-label", label]);
    if (first.status === 0) return;

    // Create (or `--force` upsert) the label, then retry.
    this.run([
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
    this.run(["issue", "edit", String(number), "--repo", repo, "--add-label", label]);
  }

  /**
   * Remove a single label. Returns `true` on success (gh exit 0), `false`
   * otherwise. Callers that need to keep local state in sync with GitHub
   * (e.g. `auto-revert.ts`) MUST check this — a transient API error,
   * 403, or rate-limit will return `false` and the caller should NOT
   * mutate its in-memory mirror. The return value is intentionally a
   * boolean (not a throw) to keep the previous "swallow + log" callers
   * working without try/catch noise; the underlying failure mode (gh
   * returns non-zero when the label isn't on the item) is harmless and
   * still represented as `false`. See `bin/github-scan-status-manager:98-103`.
   */
  removeLabel(repo: string, number: number, label: string): boolean {
    const result = this.run([
      "issue",
      "edit",
      String(number),
      "--repo",
      repo,
      "--remove-label",
      label,
    ]);
    return result.status === 0;
  }

  /**
   * Create (or force-overwrite) a label on a repo. Used by
   * `status-manager ensure-labels`. Errors swallowed to match bash.
   */
  createLabel(repo: string, label: string, color: string, description: string): GhExecResult {
    return this.run([
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
  }
}
