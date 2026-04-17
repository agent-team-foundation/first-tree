/**
 * Runtime config for breeze TS-port commands and the TS daemon backend.
 *
 * There are two config surfaces in this module:
 *
 * 1. `loadBreezeConfig` — the lightweight per-command knob bag used by
 *    `status-manager` / `poll` / etc. (Phase 2a). Env-only today.
 *
 * 2. `loadBreezeDaemonConfig` — the daemon-level config introduced in
 *    Phase 3a. Reads `~/.first-tree/breeze/config.yaml` (or the older
 *    `~/.breeze/config.yaml`, for back-compat with any hand-written
 *    files), merges with env vars and CLI overrides, and returns a
 *    validated `DaemonConfig`.
 *
 * Priority (highest wins): CLI overrides > env vars > yaml > defaults.
 *
 * NOTE: the runtime data directory (`inbox.json`, `activity.log`, claim
 * locks) remains `~/.breeze/` for Phase 3 — only the *config* moves to
 * `~/.first-tree/breeze/`. This matches the scope constraint that
 * Phase 3a must not break format parity with the Rust daemon.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export const CLAIM_TIMEOUT_SECS = 300; // 5 minutes; matches bin/breeze-status-manager:29

export interface BreezeConfig {
  /** GitHub API host, default "github.com". Mirrors runner `--host`. */
  host: string;
  /** Identity cache TTL for `~/.breeze/identity.json`. */
  identityTtlMs: number;
  /** How long a claim directory lives before it can be overwritten. */
  claimTimeoutSecs: number;
}

export interface LoadConfigDeps {
  env?: (name: string) => string | undefined;
}

/** Load the runtime config from env. Used by status-manager and friends. */
export function loadBreezeConfig(deps: LoadConfigDeps = {}): BreezeConfig {
  const env = deps.env ?? ((name) => process.env[name]);
  return {
    host: env("BREEZE_HOST") ?? env("GH_HOST") ?? "github.com",
    identityTtlMs: 24 * 60 * 60 * 1000,
    claimTimeoutSecs: CLAIM_TIMEOUT_SECS,
  };
}

/* ------------------------------------------------------------------ */
/* Phase 3a: daemon-level config                                      */
/* ------------------------------------------------------------------ */

export interface DaemonConfig {
  /** Poll cadence in seconds. Rust default: 60s. */
  pollIntervalSec: number;
  /** Per-task runtime budget. Rust equivalent lives in dispatcher (Phase 3c). */
  taskTimeoutSec: number;
  /** Log verbosity: `debug` | `info` | `warn` | `error`. */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Localhost HTTP port for the dashboard + SSE stream. */
  httpPort: number;
  /** GitHub API host. */
  host: string;
}

export const DAEMON_CONFIG_DEFAULTS: DaemonConfig = {
  pollIntervalSec: 60,
  // Phase 3c bug fix 1: per-task timeout default 30 min. Rust dispatcher
  // had no timeout (documented silent-hang failure mode in
  // `docs/migration/04-broker-agent-lifecycle.md` §8). We set a generous
  // ceiling so the broker will always eventually reclaim a stuck task.
  taskTimeoutSec: 30 * 60,
  logLevel: "info",
  httpPort: 7878,
  host: "github.com",
};

export interface DaemonCliOverrides {
  pollIntervalSec?: number;
  taskTimeoutSec?: number;
  logLevel?: string;
  httpPort?: number;
  host?: string;
}

export interface LoadDaemonConfigDeps {
  env?: (name: string) => string | undefined;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  homeDir?: () => string;
  /** Explicit path override; primarily for tests. Beats the search path. */
  configPath?: string;
  /** CLI overrides that beat env and yaml. */
  cliOverrides?: DaemonCliOverrides;
}

/**
 * Locations searched for `config.yaml`, in order. The new canonical
 * location is under `~/.first-tree/breeze/` — the older `~/.breeze/`
 * location is checked second for back-compat. First hit wins.
 */
export function breezeDaemonConfigSearchPaths(
  homeDir: string = homedir(),
): string[] {
  return [
    join(homeDir, ".first-tree", "breeze", "config.yaml"),
    join(homeDir, ".breeze", "config.yaml"),
  ];
}

interface RawYamlConfig {
  poll_interval_sec?: unknown;
  pollIntervalSec?: unknown;
  task_timeout_sec?: unknown;
  taskTimeoutSec?: unknown;
  log_level?: unknown;
  logLevel?: unknown;
  http_port?: unknown;
  httpPort?: unknown;
  host?: unknown;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickLogLevel(value: unknown): DaemonConfig["logLevel"] | undefined {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  return undefined;
}

/**
 * Load daemon config with priority: CLI overrides > env > yaml > defaults.
 *
 * Env vars honored (kept compatible with breeze-runner names):
 *   BREEZE_POLL_INTERVAL_SECS  / BREEZE_INBOX_POLL_INTERVAL_SECS
 *   BREEZE_HTTP_PORT
 *   BREEZE_LOG_LEVEL
 *   BREEZE_HOST / GH_HOST
 *   BREEZE_TASK_TIMEOUT_SECS
 *
 * The yaml schema accepts snake_case (preferred) or camelCase keys.
 * Unknown yaml keys are ignored (forward-compat).
 */
export function loadBreezeDaemonConfig(
  deps: LoadDaemonConfigDeps = {},
): DaemonConfig {
  const env = deps.env ?? ((name) => process.env[name]);
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf-8"));
  const fileExists = deps.fileExists ?? existsSync;
  const homeDir = deps.homeDir ?? homedir;
  const cli = deps.cliOverrides ?? {};

  // 1. Defaults.
  const config: DaemonConfig = { ...DAEMON_CONFIG_DEFAULTS };

  // 2. YAML overlay.
  const candidates = deps.configPath
    ? [deps.configPath]
    : breezeDaemonConfigSearchPaths(homeDir());
  for (const path of candidates) {
    if (!fileExists(path)) continue;
    let raw: string;
    try {
      raw = readFile(path);
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new Error(
        `failed to parse breeze daemon config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (parsed !== null && typeof parsed === "object") {
      const y = parsed as RawYamlConfig;
      const pollInterval = pickNumber(y.poll_interval_sec, y.pollIntervalSec);
      if (pollInterval !== undefined) config.pollIntervalSec = pollInterval;
      const taskTimeout = pickNumber(y.task_timeout_sec, y.taskTimeoutSec);
      if (taskTimeout !== undefined) config.taskTimeoutSec = taskTimeout;
      const logLevel = pickLogLevel(y.log_level ?? y.logLevel);
      if (logLevel !== undefined) config.logLevel = logLevel;
      const httpPort = pickNumber(y.http_port, y.httpPort);
      if (httpPort !== undefined && httpPort < 65_536) {
        config.httpPort = httpPort;
      }
      const host = pickString(y.host);
      if (host !== undefined) config.host = host;
    }
    // First existing file wins — stop searching.
    break;
  }

  // 3. Env overlay.
  const envPoll = pickNumber(
    env("BREEZE_POLL_INTERVAL_SECS"),
    env("BREEZE_INBOX_POLL_INTERVAL_SECS"),
  );
  if (envPoll !== undefined) config.pollIntervalSec = envPoll;
  const envTaskTimeout = pickNumber(env("BREEZE_TASK_TIMEOUT_SECS"));
  if (envTaskTimeout !== undefined) config.taskTimeoutSec = envTaskTimeout;
  const envLogLevel = pickLogLevel(env("BREEZE_LOG_LEVEL"));
  if (envLogLevel !== undefined) config.logLevel = envLogLevel;
  const envPort = pickNumber(env("BREEZE_HTTP_PORT"));
  if (envPort !== undefined && envPort < 65_536) config.httpPort = envPort;
  const envHost = pickString(env("BREEZE_HOST"), env("GH_HOST"));
  if (envHost !== undefined) config.host = envHost;

  // 4. CLI overrides.
  if (cli.pollIntervalSec !== undefined && cli.pollIntervalSec > 0) {
    config.pollIntervalSec = cli.pollIntervalSec;
  }
  if (cli.taskTimeoutSec !== undefined && cli.taskTimeoutSec > 0) {
    config.taskTimeoutSec = cli.taskTimeoutSec;
  }
  const cliLogLevel = pickLogLevel(cli.logLevel);
  if (cliLogLevel !== undefined) config.logLevel = cliLogLevel;
  if (
    cli.httpPort !== undefined &&
    cli.httpPort > 0 &&
    cli.httpPort < 65_536
  ) {
    config.httpPort = cli.httpPort;
  }
  if (cli.host !== undefined && cli.host.length > 0) {
    config.host = cli.host;
  }

  return config;
}
