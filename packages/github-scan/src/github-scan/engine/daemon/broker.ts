/**
 * Phase 3c: cross-process `gh` broker for the TypeScript github-scan daemon.
 *
 * Port of `broker.rs`.
 *
 * Purpose
 * -------
 * Agent subprocesses (codex/claude) shell out to `gh` for issue /
 * pr / review mutations. Those calls must share the same rate-limit
 * budget as the daemon and must be serialized across processes so
 * two agent runs cannot double-post a comment. The broker achieves
 * that by installing a shim `gh` binary (`SHIM_SCRIPT`) on the
 * agent's `PATH` — the shim enqueues a request directory under
 * `<broker_dir>/requests/` and polls for `response.env`. The daemon
 * drains the queue in a single thread and invokes real `gh` via
 * `GhExecutor`.
 *
 * Files on disk (identical to Rust):
 *   <broker_dir>/
 *     bin/gh                 — POSIX shim script (mode 0755)
 *     requests/
 *       req-<epoch>-<pid>-<rand>/
 *         argv.txt            — one arg per line (written by shim)
 *         cwd.txt             — pwd of the shim invocation
 *         gh_host.txt (opt)   — GH_HOST forwarded from agent env
 *         gh_repo.txt (opt)   — GH_REPO forwarded from agent env
 *         stdout.txt          — written by broker
 *         stderr.txt          — written by broker
 *         response.env        — status_code + paths + epoch
 *     history/
 *       <fingerprint-id>/
 *         stdout.txt, stderr.txt, response.env
 *         (15-minute TTL; see MUTATION_CACHE_TTL_MS)
 *
 * Correctness gaps vs Rust (flagged in spec doc 4 §11)
 * ----------------------------------------------------
 *   - Mutation-response cache can mask a human rollback. We match the
 *     15-minute TTL, but Phase 3c adds a `forceRefresh` hook that
 *     `runner-skeleton.ts` can wire to a future CLI flag. Currently
 *     unused.
 *   - Claude's stdout-to-output-file copy is handled in `runner.ts`,
 *     not here.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  GhExecutor,
  bucketForArgs,
  commandIsMutating,
  type GhCommandSpec,
} from "./gh-executor.js";

export const MUTATION_CACHE_TTL_MS = 15 * 60 * 1_000;

/**
 * Shim script the agent subprocess invokes in place of real `gh`.
 * Keep byte-for-byte stable with Rust `SHIM_SCRIPT` — any divergence
 * breaks idempotency/caching.
 */
export const SHIM_SCRIPT = `#!/bin/sh
set -eu

broker_dir="\${GITHUB_SCAN_BROKER_DIR:?missing GITHUB_SCAN_BROKER_DIR}"
requests_dir="$broker_dir/requests"
mkdir -p "$requests_dir"

suffix="$(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' ' || echo 0)"
request_dir="$requests_dir/req-$(date +%s)-$$-$suffix"
mkdir -p "$request_dir"

pwd > "$request_dir/cwd.txt"
: > "$request_dir/argv.txt"
for arg in "$@"; do
  case "$arg" in
    *'
'*)
      echo "github-scan-runner gh shim does not support newline arguments" >&2
      exit 2
      ;;
  esac
  printf '%s\\n' "$arg" >> "$request_dir/argv.txt"
done

if [ -n "\${GH_HOST:-}" ]; then
  printf '%s' "$GH_HOST" > "$request_dir/gh_host.txt"
fi

if [ -n "\${GH_REPO:-}" ]; then
  printf '%s' "$GH_REPO" > "$request_dir/gh_repo.txt"
fi

timeout_secs="\${GITHUB_SCAN_BROKER_TIMEOUT_SECS:-1800}"
deadline=$(( $(date +%s) + timeout_secs ))
while [ ! -f "$request_dir/response.env" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "github-scan-runner gh shim timed out waiting for broker" >&2
    exit 124
  fi
  sleep 0.1
done

status_code="$(sed -n 's/^status_code=//p' "$request_dir/response.env" | tail -n 1)"
stdout_path="$(sed -n 's/^stdout_path=//p' "$request_dir/response.env" | tail -n 1)"
stderr_path="$(sed -n 's/^stderr_path=//p' "$request_dir/response.env" | tail -n 1)"

if [ -n "\${stdout_path:-}" ] && [ -f "$stdout_path" ]; then
  cat "$stdout_path"
fi

if [ -n "\${stderr_path:-}" ] && [ -f "$stderr_path" ]; then
  cat "$stderr_path" >&2
fi

rm -rf "$request_dir"
exit "\${status_code:-1}"
`;

export interface GhBrokerOptions {
  brokerDir: string;
  executor: GhExecutor;
  /** Poll interval in ms between serve-loop passes. Default 100. */
  pollIntervalMs?: number;
  /** Injected clock (ms). Tests override. */
  now?: () => number;
  /** Injected logger. */
  logger?: {
    warn: (line: string) => void;
    error: (line: string) => void;
  };
}

export interface RunningBroker {
  /** Directory containing `bin/gh` shim. Set on agent `PATH`. */
  shimDir: string;
  /** `GITHUB_SCAN_BROKER_DIR` passed to the agent. */
  brokerDir: string;
  /** Stop the serve loop and wait for in-flight requests to finish. */
  stop(): Promise<void>;
  /** Resolves when the serve loop exits (either via stop or error). */
  done: Promise<void>;
}

/** Start the broker and its serve loop. */
export async function startGhBroker(
  options: GhBrokerOptions,
): Promise<RunningBroker> {
  const brokerDir = options.brokerDir;
  const requestsDir = join(brokerDir, "requests");
  const historyDir = join(brokerDir, "history");
  const binDir = join(brokerDir, "bin");
  ensureDir(requestsDir);
  ensureDir(historyDir);
  ensureDir(binDir);

  const shimPath = join(binDir, "gh");
  writeFileSync(shimPath, SHIM_SCRIPT);
  if (process.platform !== "win32") {
    chmodSync(shimPath, 0o755);
  }

  // Purge stale requests from a previous process.
  purgeStaleRequests(requestsDir);

  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? {
    warn: (line: string) => process.stderr.write(`WARN: ${line}\n`),
    error: (line: string) => process.stderr.write(`ERROR: ${line}\n`),
  };
  const stop = { flag: false };

  const done = (async () => {
    while (!stop.flag) {
      let pending: string[];
      try {
        pending = listPendingRequests(requestsDir);
      } catch (err) {
        logger.error(
          `broker: failed to scan request queue: ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(250);
        continue;
      }

      if (pending.length === 0) {
        await sleep(pollIntervalMs);
        continue;
      }

      for (const requestDir of pending) {
        if (stop.flag) return;
        try {
          await handleRequest({
            requestDir,
            historyDir,
            executor: options.executor,
            now,
          });
        } catch (err) {
          try {
            writeFailureResponse(
              requestDir,
              err instanceof Error ? err.message : String(err),
              now,
            );
          } catch (writeErr) {
            logger.warn(
              `broker: failed to write failure response for ${requestDir}: ${
                writeErr instanceof Error
                  ? writeErr.message
                  : String(writeErr)
              }`,
            );
          }
        }
      }
    }
  })();

  return {
    shimDir: binDir,
    brokerDir,
    async stop(): Promise<void> {
      stop.flag = true;
      await done;
    },
    done,
  };
}

function listPendingRequests(requestsDir: string): string[] {
  const entries = readdirSync(requestsDir, { withFileTypes: true });
  const pending: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(requestsDir, entry.name);
    if (existsSync(join(dir, "response.env"))) continue;
    // The shim writes argv.txt after mkdir; skip dirs without it to
    // avoid racing against partial writes.
    if (!existsSync(join(dir, "argv.txt"))) continue;
    pending.push(dir);
  }
  pending.sort();
  return pending;
}

function purgeStaleRequests(requestsDir: string): void {
  if (!existsSync(requestsDir)) return;
  for (const entry of readdirSync(requestsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(requestsDir, entry.name);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

interface HandleRequestOptions {
  requestDir: string;
  historyDir: string;
  executor: GhExecutor;
  now: () => number;
}

async function handleRequest(opts: HandleRequestOptions): Promise<void> {
  const { requestDir, historyDir, executor, now } = opts;
  const args = readLines(join(requestDir, "argv.txt"));
  const cwd = readTextIfExists(join(requestDir, "cwd.txt")).trim();
  const ghHost = readTextIfExists(join(requestDir, "gh_host.txt")).trim();
  const ghRepo = readTextIfExists(join(requestDir, "gh_repo.txt")).trim();

  const envs: Record<string, string> = {};
  if (ghHost) envs.GH_HOST = ghHost;
  if (ghRepo) envs.GH_REPO = ghRepo;

  const spec: GhCommandSpec = {
    context: `brokered gh ${args.join(" ")}`,
    cwd: cwd || undefined,
    envs,
    bucket: bucketForArgs(args),
    mutating: commandIsMutating(args),
    args,
  };

  const fingerprint = mutationFingerprint(spec);
  if (fingerprint !== undefined) {
    const cached = readCachedMutationResponse({
      historyDir,
      fingerprint,
      now,
    });
    if (cached) {
      writeSuccessResponse({
        requestDir,
        stdout: cached.stdout,
        stderr: cached.stderr,
        statusCode: cached.statusCode,
        now,
      });
      return;
    }
  }

  const output = await executor.run(spec);
  if (output.statusCode === 0 && fingerprint !== undefined) {
    writeCachedMutationResponse({
      historyDir,
      fingerprint,
      stdout: output.stdout,
      stderr: output.stderr,
      statusCode: output.statusCode,
      now,
    });
  }
  writeSuccessResponse({
    requestDir,
    stdout: output.stdout,
    stderr: output.stderr,
    statusCode: output.statusCode,
    now,
  });
}

interface CachedMutationResponse {
  stdout: string;
  stderr: string;
  statusCode: number;
}

/**
 * Normalize a spec into a cache-stable key. Bodies and body-files are
 * hashed so retries with the same payload hit the cache even when the
 * tmp file path differs. Matches Rust `mutation_fingerprint`.
 */
export function mutationFingerprint(
  spec: GhCommandSpec,
): string | undefined {
  if (!spec.mutating) return undefined;
  const normalized: string[] = [];
  const args = spec.args;
  let i = 0;
  while (i < args.length) {
    const current = args[i];
    if (current === "--body" || current === "-b") {
      normalized.push(current);
      const body = args[i + 1];
      if (body !== undefined) {
        normalized.push(`body-hash:${stableFileId(body)}`);
        i += 2;
        continue;
      }
    } else if (current === "--body-file" || current === "-F") {
      normalized.push(current);
      const path = args[i + 1];
      if (path !== undefined) {
        const contents = readBodyFile(path, spec);
        normalized.push(`body-file-hash:${stableFileId(contents)}`);
        i += 2;
        continue;
      }
    }
    normalized.push(current);
    i += 1;
  }

  const envs = Object.entries(spec.envs ?? {})
    .filter(([key]) => key === "GH_HOST" || key === "GH_REPO")
    .sort(([a1, a2], [b1, b2]) => (a1 === b1 ? a2.localeCompare(b2) : a1.localeCompare(b1)));
  for (const [key, value] of envs) {
    normalized.push(`env:${key}=${value}`);
  }
  if (spec.cwd) {
    normalized.push(`cwd:${spec.cwd}`);
  }
  return normalized.join("\n");
}

function readBodyFile(path: string, spec: GhCommandSpec): string {
  const abs = isAbsolute(path)
    ? path
    : spec.cwd
      ? resolve(spec.cwd, path)
      : path;
  if (!existsSync(abs)) {
    throw new Error(
      `missing body file for brokered gh command: ${abs}`,
    );
  }
  return readFileSync(abs, "utf8");
}

function cacheDirFor(historyDir: string, fingerprint: string): string {
  return join(historyDir, stableFileId(fingerprint));
}

interface ReadCachedOptions {
  historyDir: string;
  fingerprint: string;
  now: () => number;
}

export function readCachedMutationResponse(
  opts: ReadCachedOptions,
): CachedMutationResponse | undefined {
  const dir = cacheDirFor(opts.historyDir, opts.fingerprint);
  const responseFile = join(dir, "response.env");
  if (!existsSync(responseFile)) return undefined;
  const values = parseKvLines(readFileSync(responseFile, "utf8"));
  const completedAt = Number.parseInt(values.completed_at_ms ?? "0", 10) || 0;
  if (opts.now() - completedAt > MUTATION_CACHE_TTL_MS) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  const statusCode = Number.parseInt(values.status_code ?? "1", 10);
  if (!Number.isFinite(statusCode) || statusCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  const stdout = readTextIfExists(join(dir, "stdout.txt"));
  const stderr = readTextIfExists(join(dir, "stderr.txt"));
  return { stdout, stderr, statusCode };
}

interface WriteCachedOptions {
  historyDir: string;
  fingerprint: string;
  stdout: string;
  stderr: string;
  statusCode: number;
  now: () => number;
}

export function writeCachedMutationResponse(
  opts: WriteCachedOptions,
): void {
  const dir = cacheDirFor(opts.historyDir, opts.fingerprint);
  ensureDir(dir);
  writeFileSync(join(dir, "stdout.txt"), opts.stdout);
  writeFileSync(join(dir, "stderr.txt"), opts.stderr);
  writeFileSync(
    join(dir, "response.env"),
    [
      `status_code=${opts.statusCode}`,
      `completed_at_ms=${opts.now()}`,
      "",
    ].join("\n"),
  );
}

interface WriteSuccessOptions {
  requestDir: string;
  stdout: string;
  stderr: string;
  statusCode: number;
  now: () => number;
}

function writeSuccessResponse(opts: WriteSuccessOptions): void {
  // Defensive: the shim's request dir can be cleaned up concurrently
  // (external reaper, shim timeout abandon). Recreate it so our writes
  // don't ENOENT and crash the broker loop.
  ensureDir(opts.requestDir);
  const stdoutPath = join(opts.requestDir, "stdout.txt");
  const stderrPath = join(opts.requestDir, "stderr.txt");
  writeFileSync(stdoutPath, opts.stdout);
  writeFileSync(stderrPath, opts.stderr);
  writeFileSync(
    join(opts.requestDir, "response.env"),
    [
      `status_code=${opts.statusCode}`,
      `stdout_path=${stdoutPath}`,
      `stderr_path=${stderrPath}`,
      `completed_at_ms=${opts.now()}`,
      "",
    ].join("\n"),
  );
}

function writeFailureResponse(
  requestDir: string,
  error: string,
  now: () => number,
): void {
  // Defensive: same concurrent-cleanup rationale as writeSuccessResponse.
  ensureDir(requestDir);
  const stdoutPath = join(requestDir, "stdout.txt");
  const stderrPath = join(requestDir, "stderr.txt");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, error);
  writeFileSync(
    join(requestDir, "response.env"),
    [
      "status_code=1",
      `stdout_path=${stdoutPath}`,
      `stderr_path=${stderrPath}`,
      `completed_at_ms=${now()}`,
      "",
    ].join("\n"),
  );
}

/* ------------------------ low-level helpers ------------------------ */

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readTextIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readLines(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}

function parseKvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    if (!key) continue;
    result[key] = line.slice(eq + 1);
  }
  return result;
}

/** Rust `util::stable_file_id` is a sha256 hex. Match it. */
export function stableFileId(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 32);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
