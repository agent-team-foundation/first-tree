/**
 * Runtime config for github-scan TS-port commands and the TS daemon backend.
 *
 * There are two config surfaces in this module:
 *
 * 1. `loadGitHubScanConfig` — the lightweight per-command knob bag used by
 *    `status-manager` / `poll` / etc. (Phase 2a). Env-only today.
 *
 * 2. `loadGitHubScanDaemonConfig` — the daemon-level config introduced in
 *    Phase 3a. Reads `~/.first-tree/github-scan/config.yaml`, merges with env vars and
 *    CLI overrides, and returns a validated `DaemonConfig`.
 *
 * Priority (highest wins): CLI overrides > env vars > yaml > defaults.
 *
 * NOTE: runtime data (`inbox.json`, `activity.log`, claim locks, and
 * config.yaml`) live under `GITHUB_SCAN_DIR` when set, else `~/.first-tree/github-scan/`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export const CLAIM_TIMEOUT_SECS = 300; // 5 minutes; matches bin/github-scan-status-manager:29
export const GITHUB_SCAN_TREE_REPO_ENV = "FIRST_TREE_GITHUB_SCAN_TREE_REPO";

function parseTreeRepo(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface GitHubScanConfig {
  /** GitHub API host, default "github.com". Mirrors runner `--host`. */
  host: string;
  /** Identity cache TTL for `~/.first-tree/github-scan/identity.json`. */
  identityTtlMs: number;
  /** How long a claim directory lives before it can be overwritten. */
  claimTimeoutSecs: number;
  /** Optional bound tree repo (`owner/repo`) supplied by the umbrella CLI. */
  treeRepo?: string;
}

export interface LoadConfigDeps {
  env?: (name: string) => string | undefined;
}

/** Load the runtime config from env. Used by status-manager and friends. */
export function loadGitHubScanConfig(deps: LoadConfigDeps = {}): GitHubScanConfig {
  const env = deps.env ?? ((name) => process.env[name]);
  const base: GitHubScanConfig = {
    host: env("GITHUB_SCAN_HOST") ?? env("GH_HOST") ?? "github.com",
    identityTtlMs: 24 * 60 * 60 * 1000,
    claimTimeoutSecs: CLAIM_TIMEOUT_SECS,
  };
  const treeRepo = parseTreeRepo(env(GITHUB_SCAN_TREE_REPO_ENV));
  return treeRepo ? { ...base, treeRepo } : base;
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
  /**
   * Max concurrent agent tasks the dispatcher may run at once.
   * Formerly hardcoded to 2; bumped to 20 after a live smoke showed
   * the infra handles that comfortably. Tunable via
   * `GITHUB_SCAN_MAX_PARALLEL` or `max_parallel` in yaml.
   */
  maxParallel: number;
  /**
   * Per-poll cap on search-based candidates. Only the search path is
   * limited; the notifications path returns everything it sees.
   * Tunable via `GITHUB_SCAN_SEARCH_LIMIT` or `search_limit` in yaml.
   */
  searchLimit: number;
  /** Optional bound tree repo (`owner/repo`) supplied by the umbrella CLI. */
  treeRepo?: string;
  /**
   * GitHub login used as the daemon's "agent identity" — comments
   * authored by this login are treated as the agent's own and skipped
   * by the auto-revert own-comment guard (issue #360).
   *
   * Resolution order (highest wins):
   *   1. CLI flag `--agent-login`
   *   2. Env var `GITHUB_SCAN_AGENT_LOGIN`
   *   3. Yaml key `agent_login` / `agentLogin`
   *   4. Fallback (caller-resolved): the daemon's `gh auth` login
   *
   * When undefined here, callers must fall back to `gh auth` identity.
   */
  agentLogin?: string;
}

export const DAEMON_CONFIG_DEFAULTS: DaemonConfig = {
  pollIntervalSec: 60,
  // Phase 3c bug fix 1: per-task timeout default 30 min. Rust dispatcher
  // had no timeout (documented silent-hang failure mode in
  // the broker/agent lifecycle spec (historical migration doc, now removed; see git history) §8). We set a generous
  // ceiling so the broker will always eventually reclaim a stuck task.
  taskTimeoutSec: 30 * 60,
  logLevel: "info",
  httpPort: 7878,
  host: "github.com",
  maxParallel: 20,
  searchLimit: 10,
};

export interface DaemonCliOverrides {
  pollIntervalSec?: number;
  taskTimeoutSec?: number;
  logLevel?: string;
  httpPort?: number;
  host?: string;
  maxParallel?: number;
  searchLimit?: number;
  agentLogin?: string;
}

export interface LoadDaemonConfigDeps {
  env?: (name: string) => string | undefined;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  homeDir?: () => string;
  /** Explicit github-scan store root; beats GITHUB_SCAN_DIR and the default ~/.first-tree/github-scan path. */
  githubScanDir?: string;
  /** Explicit path override; primarily for tests. Beats the search path. */
  configPath?: string;
  /** CLI overrides that beat env and yaml. */
  cliOverrides?: DaemonCliOverrides;
}

/**
 * Location searched for `config.yaml`.
 */
export function githubScanDaemonConfigSearchPaths(
  homeDir: string = homedir(),
  githubScanDir?: string,
): string[] {
  return [join(githubScanDir ?? join(homeDir, ".first-tree/github-scan"), "config.yaml")];
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
  max_parallel?: unknown;
  maxParallel?: unknown;
  search_limit?: unknown;
  searchLimit?: unknown;
  agent_login?: unknown;
  agentLogin?: unknown;
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
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return undefined;
}

/**
 * Load daemon config with priority: CLI overrides > env > yaml > defaults.
 *
 * Env vars honored (kept compatible with github-scan-runner names):
 *   GITHUB_SCAN_POLL_INTERVAL_SECS  / GITHUB_SCAN_INBOX_POLL_INTERVAL_SECS
 *   GITHUB_SCAN_HTTP_PORT
 *   GITHUB_SCAN_LOG_LEVEL
 *   GITHUB_SCAN_HOST / GH_HOST
 *   GITHUB_SCAN_TASK_TIMEOUT_SECS
 *   GITHUB_SCAN_MAX_PARALLEL
 *   GITHUB_SCAN_SEARCH_LIMIT
 *   GITHUB_SCAN_AGENT_LOGIN
 *
 * The yaml schema accepts snake_case (preferred) or camelCase keys.
 * Unknown yaml keys are ignored (forward-compat).
 */
// oxlint-disable-next-line complexity
export function loadGitHubScanDaemonConfig(deps: LoadDaemonConfigDeps = {}): DaemonConfig {
  const env = deps.env ?? ((name) => process.env[name]);
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf-8"));
  const fileExists = deps.fileExists ?? existsSync;
  const homeDir = deps.homeDir ?? homedir;
  const cli = deps.cliOverrides ?? {};
  const githubScanDir = deps.githubScanDir ?? env("GITHUB_SCAN_DIR");
  const treeRepo = parseTreeRepo(env(GITHUB_SCAN_TREE_REPO_ENV));

  // 1. Defaults.
  const config: DaemonConfig = { ...DAEMON_CONFIG_DEFAULTS };

  // 2. YAML overlay.
  const candidates = deps.configPath
    ? [deps.configPath]
    : githubScanDaemonConfigSearchPaths(homeDir(), githubScanDir);
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
        `failed to parse github-scan daemon config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
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
      const maxParallel = pickNumber(y.max_parallel, y.maxParallel);
      if (maxParallel !== undefined) config.maxParallel = maxParallel;
      const searchLimit = pickNumber(y.search_limit, y.searchLimit);
      if (searchLimit !== undefined) config.searchLimit = searchLimit;
      const agentLogin = pickString(y.agent_login, y.agentLogin);
      if (agentLogin !== undefined) config.agentLogin = agentLogin;
    }
    // First existing file wins — stop searching.
    break;
  }

  // 3. Env overlay.
  const envPoll = pickNumber(
    env("GITHUB_SCAN_POLL_INTERVAL_SECS"),
    env("GITHUB_SCAN_INBOX_POLL_INTERVAL_SECS"),
  );
  if (envPoll !== undefined) config.pollIntervalSec = envPoll;
  const envTaskTimeout = pickNumber(env("GITHUB_SCAN_TASK_TIMEOUT_SECS"));
  if (envTaskTimeout !== undefined) config.taskTimeoutSec = envTaskTimeout;
  const envLogLevel = pickLogLevel(env("GITHUB_SCAN_LOG_LEVEL"));
  if (envLogLevel !== undefined) config.logLevel = envLogLevel;
  const envPort = pickNumber(env("GITHUB_SCAN_HTTP_PORT"));
  if (envPort !== undefined && envPort < 65_536) config.httpPort = envPort;
  const envHost = pickString(env("GITHUB_SCAN_HOST"), env("GH_HOST"));
  if (envHost !== undefined) config.host = envHost;
  const envMaxParallel = pickNumber(env("GITHUB_SCAN_MAX_PARALLEL"));
  if (envMaxParallel !== undefined) config.maxParallel = envMaxParallel;
  const envSearchLimit = pickNumber(env("GITHUB_SCAN_SEARCH_LIMIT"));
  if (envSearchLimit !== undefined) config.searchLimit = envSearchLimit;
  const envAgentLogin = pickString(env("GITHUB_SCAN_AGENT_LOGIN"));
  if (envAgentLogin !== undefined) config.agentLogin = envAgentLogin;

  // 4. CLI overrides.
  if (cli.pollIntervalSec !== undefined && cli.pollIntervalSec > 0) {
    config.pollIntervalSec = cli.pollIntervalSec;
  }
  if (cli.taskTimeoutSec !== undefined && cli.taskTimeoutSec > 0) {
    config.taskTimeoutSec = cli.taskTimeoutSec;
  }
  const cliLogLevel = pickLogLevel(cli.logLevel);
  if (cliLogLevel !== undefined) config.logLevel = cliLogLevel;
  if (cli.httpPort !== undefined && cli.httpPort > 0 && cli.httpPort < 65_536) {
    config.httpPort = cli.httpPort;
  }
  if (cli.host !== undefined && cli.host.length > 0) {
    config.host = cli.host;
  }
  if (cli.maxParallel !== undefined && cli.maxParallel > 0) {
    config.maxParallel = cli.maxParallel;
  }
  if (cli.searchLimit !== undefined && cli.searchLimit > 0) {
    config.searchLimit = cli.searchLimit;
  }
  if (cli.agentLogin !== undefined && cli.agentLogin.length > 0) {
    config.agentLogin = cli.agentLogin;
  }

  return treeRepo ? { ...config, treeRepo } : config;
}
